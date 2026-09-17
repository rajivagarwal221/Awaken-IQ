require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const prisma = require('./db');
const xlsx = require('xlsx');
const {
    parseDdMmYyyy,
    toGenderEnum,
    parseCurrency,
    buildLegacyUser,
    slugify,
} = require('./mappers');

const app = express();
const PORT = process.env.PORT || 8080;

// ----------------------------------------------------------------------------
// Rate Limiting & Audit Logging Helpers
// ----------------------------------------------------------------------------

const loginAttempts = new Map();

function checkLoginRateLimit(key) {
    const record = loginAttempts.get(key);
    if (!record) return { allowed: true };
    if (record.lockUntil && Date.now() < record.lockUntil) {
        const remainingMinutes = Math.ceil((record.lockUntil - Date.now()) / 60000);
        return { allowed: false, remainingMinutes };
    }
    if (record.lockUntil && Date.now() >= record.lockUntil) {
        loginAttempts.delete(key);
        return { allowed: true };
    }
    return { allowed: true };
}

function recordFailedLogin(key) {
    const record = loginAttempts.get(key) || { count: 0 };
    record.count += 1;
    if (record.count >= 5) {
        record.lockUntil = Date.now() + 15 * 60 * 1000;
    }
    loginAttempts.set(key, record);
}

function resetLoginRateLimit(key) {
    loginAttempts.delete(key);
}

async function logAuditEvent(adminId, action, details, req) {
    try {
        const rawIp = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress || null) : null;
        const ipAddress = Array.isArray(rawIp) ? rawIp[0] : rawIp;
        await prisma.auditLog.create({
            data: {
                adminId: adminId || null,
                action,
                details: typeof details === 'object' ? JSON.stringify(details) : (details || null),
                ipAddress: ipAddress ? String(ipAddress) : null,
            },
        });
    } catch (err) {
        console.error('Failed to log audit event:', err);
    }
}

// ----------------------------------------------------------------------------
// Authentication & Authorization Middleware
// ----------------------------------------------------------------------------

function requireAdminAuth(allowedRoles = ['ADMIN', 'STAFF', 'SUPER_ADMIN']) {
    return async (req, res, next) => {
        try {
            let token = req.signedCookies.adminSessionToken || req.cookies.adminSessionToken;
            if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
                token = req.headers.authorization.split(' ')[1];
            }

            if (!token) {
                return res.status(401).json({ error: 'Authentication required. Please log in.' });
            }

            const session = await prisma.adminSession.findUnique({
                where: { token },
                include: { admin: true },
            });

            if (!session) {
                return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
            }

            if (new Date() > new Date(session.expiresAt)) {
                await prisma.adminSession.delete({ where: { token } }).catch(() => {});
                res.clearCookie('adminSessionToken');
                return res.status(401).json({ error: 'Session expired. Please log in again.' });
            }

            if (!session.admin || !session.admin.isActive) {
                return res.status(401).json({ error: 'Account disabled or not found.' });
            }

            const userRole = session.admin.role;
            if (allowedRoles.length > 0 && !allowedRoles.includes(userRole) && userRole !== 'SUPER_ADMIN') {
                return res.status(403).json({ error: 'Access denied: Insufficient permissions for this action.' });
            }

            req.admin = session.admin;
            req.adminSession = session;
            next();
        } catch (err) {
            console.error('Error in admin auth middleware:', err);
            return res.status(500).json({ error: 'Internal server error' });
        }
    };
}

// Multer stores uploaded video files on disk (frontend/uploads).
// References (title, URL, addedAt) are stored in the student_improvement_videos PostgreSQL table.
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, '../frontend/uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(cookieParser(process.env.COOKIE_SECRET || '***REMOVED***'));
app.use(express.urlencoded({ extended: true }));

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function findParentAndPrimaryStudent(email) {
    const parent = await prisma.parent.findUnique({ where: { email } });
    if (!parent) return null;

    const student = await prisma.student.findFirst({
        where: { parentId: parent.id },
        orderBy: { createdAt: 'asc' },
        include: {
            improvementVideos: { orderBy: { addedAt: 'desc' } },
            feedback: { orderBy: { createdAt: 'desc' } },
            enrollments: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                include: {
                    program: true,
                    payments: { orderBy: { createdAt: 'desc' }, take: 1 },
                },
            },
        },
    });
    if (!student) return null;

    const enrollment = student.enrollments[0] || null;
    const payment = enrollment ? enrollment.payments[0] || null : null;

    return { parent, student, enrollment, payment };
}

async function findOrCreateProgramByName(programName, durationHint) {
    if (!programName) return null;
    let program = await prisma.program.findFirst({
        where: { title: { equals: programName, mode: 'insensitive' } },
    });
    if (program) return program;

    const baseSlug = slugify(programName);
    let slug = baseSlug;
    let suffix = 1;
    while (await prisma.program.findUnique({ where: { slug } })) {
        slug = `${baseSlug}-${++suffix}`;
    }
    program = await prisma.program.create({
        data: {
            title: programName,
            slug,
            description: `${programName} program.`,
            durationText: durationHint || 'N/A',
            ageGroup: 'All ages',
            price: 0,
            status: 'DRAFT',
        },
    });
    return program;
}

// ----------------------------------------------------------------------------
// Auth / session
// ----------------------------------------------------------------------------

// Check logged in user session (Student/Parent access)
app.get('/api/session', async (req, res) => {
    const userEmail = req.signedCookies.userEmail;
    if (!userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
        const found = await findParentAndPrimaryStudent(userEmail);
        if (!found) {
            res.clearCookie('userEmail');
            return res.status(401).json({ error: 'User not found' });
        }

        const user = buildLegacyUser({
            parent: found.parent,
            student: found.student,
            enrollment: found.enrollment,
            payment: found.payment,
            videos: found.student.improvementVideos,
            feedbacks: found.student.feedback,
        });
        res.json({ user });
    } catch (err) {
        console.error('Error fetching session:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Register new user (creates Parent + Student, and Enrollment/Payment)
app.post('/api/register', async (req, res) => {
    const { studentInfo, parentInfo, courseInfo, paymentInfo, password } = req.body;

    if (!parentInfo || !parentInfo.email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }
    if (!studentInfo || !studentInfo.fullName) {
        return res.status(400).json({ error: 'Student information is required.' });
    }

    try {
        const existingParent = await prisma.parent.findUnique({
            where: { email: parentInfo.email },
        });
        if (existingParent) {
            return res.status(400).json({ error: 'Email already registered.' });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const dateOfBirth = parseDdMmYyyy(studentInfo.birthDate) || new Date();

        const result = await prisma.$transaction(async (tx) => {
            const parent = await tx.parent.create({
                data: {
                    fullName: parentInfo.parent_name,
                    relationship: parentInfo.relationship || 'guardian',
                    mobile: parentInfo.mobile || '',
                    alternateMobile: parentInfo.alt_mobile || null,
                    email: parentInfo.email,
                    passwordHash,
                    residentialAddress: parentInfo.address || '',
                    city: parentInfo.city || '',
                    state: parentInfo.state || '',
                    pincode: parentInfo.pincode || '',
                },
            });

            const student = await tx.student.create({
                data: {
                    parentId: parent.id,
                    fullName: studentInfo.fullName,
                    dateOfBirth,
                    gender: toGenderEnum(studentInfo.gender),
                    classGrade: studentInfo.grade || '',
                    schoolName: studentInfo.schoolName || '',
                    hasSpecialNeeds: !!studentInfo.specialNeeds,
                    specialNeedsDescription: studentInfo.specialNeeds
                        ? studentInfo.specialDetails || ''
                        : null,
                },
            });

            let enrollment = null;
            let payment = null;

            if (courseInfo && courseInfo.program) {
                const program = await findOrCreateProgramByName(courseInfo.program, courseInfo.duration);

                enrollment = await tx.enrollment.create({
                    data: {
                        studentId: student.id,
                        programId: program.id,
                        status: paymentInfo && paymentInfo.status === 'Paid' ? 'PAID' : 'SUBMITTED',
                        enrollmentDate: new Date(),
                    },
                });

                if (paymentInfo) {
                    const amount = parseCurrency(courseInfo.price);
                    payment = await tx.payment.create({
                        data: {
                            parentId: parent.id,
                            studentId: student.id,
                            programId: program.id,
                            enrollmentId: enrollment.id,
                            amount,
                            totalPayable: amount,
                            currency: 'INR',
                            gateway: 'RAZORPAY',
                            razorpayOrderId: paymentInfo.orderId || null,
                            razorpayPaymentId: paymentInfo.txId || null,
                            status: paymentInfo.status === 'Paid' ? 'SUCCESS' : 'PENDING',
                            paymentDate: paymentInfo.status === 'Paid' ? new Date() : null,
                        },
                    });
                }
            }

            return { parent, student, enrollment, payment };
        });

        res.cookie('userEmail', result.parent.email, {
            signed: true,
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000, // 1 day
        });

        res.status(201).json({ message: 'Registration successful', userId: result.student.id });
    } catch (err) {
        console.error('Error during registration:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Login user (Student Portal authentication)
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }

    try {
        const parent = await prisma.parent.findUnique({ where: { email } });
        if (!parent) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const valid = await bcrypt.compare(password, parent.passwordHash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const student = await prisma.student.findFirst({
            where: { parentId: parent.id },
            orderBy: { createdAt: 'asc' },
        });

        res.cookie('userEmail', parent.email, {
            signed: true,
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000,
        });

        res.json({ message: 'Login successful', userId: student ? student.id : parent.id });
    } catch (err) {
        console.error('Error during login:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Logout user
app.post('/api/logout', (req, res) => {
    res.clearCookie('userEmail');
    res.json({ message: 'Logout successful' });
});

// ----------------------------------------------------------------------------
// Management / Staff Authentication Endpoints
// ----------------------------------------------------------------------------

// Management Login Endpoint
app.post('/api/admin/login', async (req, res) => {
    const { email, username, password } = req.body;
    const loginIdentifier = (email || username || '').trim().toLowerCase();

    if (!loginIdentifier || !password) {
        return res.status(400).json({ error: 'Username/Email and password are required.' });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const rateLimitKey = `${ip}:${loginIdentifier}`;
    const rateCheck = checkLoginRateLimit(rateLimitKey);

    if (!rateCheck.allowed) {
        return res.status(429).json({
            error: `Too many failed login attempts. Please try again in ${rateCheck.remainingMinutes} minutes.`
        });
    }

    try {
        const admin = await prisma.admin.findFirst({
            where: {
                email: { equals: loginIdentifier, mode: 'insensitive' },
                deletedAt: null
            }
        });

        if (!admin || !admin.isActive) {
            recordFailedLogin(rateLimitKey);
            await logAuditEvent(null, 'MANAGEMENT_LOGIN_FAILED', { identifier: loginIdentifier, reason: 'Invalid user or inactive' }, req);
            return res.status(401).json({ error: 'Invalid email/username or password.' });
        }

        const validPassword = await bcrypt.compare(password, admin.passwordHash);
        if (!validPassword) {
            recordFailedLogin(rateLimitKey);
            await logAuditEvent(admin.id, 'MANAGEMENT_LOGIN_FAILED', { identifier: loginIdentifier, reason: 'Invalid password' }, req);
            return res.status(401).json({ error: 'Invalid email/username or password.' });
        }

        resetLoginRateLimit(rateLimitKey);

        await prisma.adminSession.deleteMany({
            where: {
                OR: [
                    { adminId: admin.id, expiresAt: { lte: new Date() } }
                ]
            }
        }).catch(() => {});

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);

        await prisma.adminSession.create({
            data: {
                adminId: admin.id,
                token,
                expiresAt
            }
        });

        res.cookie('adminSessionToken', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 8 * 60 * 60 * 1000
        });

        await logAuditEvent(admin.id, 'MANAGEMENT_LOGIN_SUCCESS', { email: admin.email, role: admin.role }, req);

        res.json({
            message: 'Management login successful',
            user: {
                id: admin.id,
                name: admin.name,
                email: admin.email,
                role: admin.role
            }
        });
    } catch (err) {
        console.error('Error in management login:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Management Logout Endpoint
app.post('/api/admin/logout', async (req, res) => {
    let token = req.signedCookies.adminSessionToken || req.cookies.adminSessionToken;
    if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        token = req.headers.authorization.split(' ')[1];
    }

    if (token) {
        const session = await prisma.adminSession.findUnique({ where: { token } }).catch(() => null);
        if (session) {
            await logAuditEvent(session.adminId, 'MANAGEMENT_LOGOUT', {}, req);
            await prisma.adminSession.delete({ where: { token } }).catch(() => {});
        }
    }

    res.clearCookie('adminSessionToken');
    res.json({ message: 'Management logout successful' });
});

// Get Current Authenticated Admin/Staff details
app.get('/api/admin/me', requireAdminAuth(['ADMIN', 'STAFF', 'SUPER_ADMIN', 'SUPPORT']), async (req, res) => {
    res.json({
        user: {
            id: req.admin.id,
            name: req.admin.name,
            email: req.admin.email,
            role: req.admin.role
        }
    });
});

// Authenticated Password Change
app.post('/api/admin/change-password', requireAdminAuth(['ADMIN', 'STAFF', 'SUPER_ADMIN', 'SUPPORT']), async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Current password and new password are required.' });
    }
    if (newPassword.length < 8) {
        return res.status(400).json({ error: 'New password must be at least 8 characters long.' });
    }

    try {
        const admin = await prisma.admin.findUnique({ where: { id: req.admin.id } });
        if (!admin) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const isValid = await bcrypt.compare(currentPassword, admin.passwordHash);
        if (!isValid) {
            await logAuditEvent(req.admin.id, 'PASSWORD_CHANGE_FAILED', { reason: 'Current password mismatch' }, req);
            return res.status(400).json({ error: 'Current password is incorrect.' });
        }

        const newHash = await bcrypt.hash(newPassword, 12);
        await prisma.admin.update({
            where: { id: req.admin.id },
            data: { passwordHash: newHash }
        });

        await prisma.adminSession.deleteMany({
            where: {
                adminId: req.admin.id,
                token: { not: req.adminSession.token }
            }
        });

        await logAuditEvent(req.admin.id, 'PASSWORD_CHANGE_SUCCESS', {}, req);

        res.json({ message: 'Password updated successfully.' });
    } catch (err) {
        console.error('Error changing password:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Password Reset Token Request
app.post('/api/admin/request-reset-password', async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ error: 'Email is required.' });
    }

    try {
        const admin = await prisma.admin.findFirst({
            where: { email: { equals: email.trim(), mode: 'insensitive' }, deletedAt: null }
        });

        if (admin && admin.isActive) {
            const rawToken = crypto.randomBytes(32).toString('hex');
            const tokenHash = await bcrypt.hash(rawToken, 10);
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

            await prisma.passwordResetToken.create({
                data: {
                    adminId: admin.id,
                    tokenHash,
                    expiresAt
                }
            });

            await logAuditEvent(admin.id, 'PASSWORD_RESET_TOKEN_GENERATED', {}, req);

            return res.json({
                message: 'If an account with that email exists, a password reset token has been generated.',
                resetToken: rawToken
            });
        }

        res.json({ message: 'If an account with that email exists, a password reset token has been generated.' });
    } catch (err) {
        console.error('Error requesting password reset:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Password Reset Execution with Single-Use Token
app.post('/api/admin/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
        return res.status(400).json({ error: 'Reset token and new password are required.' });
    }
    if (newPassword.length < 8) {
        return res.status(400).json({ error: 'New password must be at least 8 characters long.' });
    }

    try {
        const activeTokens = await prisma.passwordResetToken.findMany({
            where: {
                used: false,
                expiresAt: { gt: new Date() }
            }
        });

        let matchedTokenRecord = null;
        for (const tRecord of activeTokens) {
            const isMatch = await bcrypt.compare(token, tRecord.tokenHash);
            if (isMatch) {
                matchedTokenRecord = tRecord;
                break;
            }
        }

        if (!matchedTokenRecord) {
            return res.status(400).json({ error: 'Invalid or expired password reset token.' });
        }

        const newHash = await bcrypt.hash(newPassword, 12);

        await prisma.$transaction([
            prisma.admin.update({
                where: { id: matchedTokenRecord.adminId },
                data: { passwordHash: newHash }
            }),
            prisma.passwordResetToken.update({
                where: { id: matchedTokenRecord.id },
                data: { used: true }
            }),
            prisma.adminSession.deleteMany({
                where: { adminId: matchedTokenRecord.adminId }
            })
        ]);

        await logAuditEvent(matchedTokenRecord.adminId, 'PASSWORD_RESET_SUCCESS', {}, req);

        res.json({ message: 'Password reset successful. Please log in with your new password.' });
    } catch (err) {
        console.error('Error resetting password:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Audit Logs Viewer (Admin Only)
app.get('/api/admin/audit-logs', requireAdminAuth(['ADMIN', 'SUPER_ADMIN']), async (req, res) => {
    try {
        const logs = await prisma.auditLog.findMany({
            orderBy: { createdAt: 'desc' },
            take: 100,
            include: {
                admin: {
                    select: { id: true, name: true, email: true, role: true }
                }
            }
        });
        res.json({ auditLogs: logs });
    } catch (err) {
        console.error('Error fetching audit logs:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ----------------------------------------------------------------------------
// Improvement videos (parent upload / admin review)
// ----------------------------------------------------------------------------

app.post('/api/improvements', upload.single('videoFile'), async (req, res) => {
    const userEmail = req.signedCookies.userEmail;
    if (!userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const { title } = req.body;
    if (!title || !req.file) {
        return res.status(400).json({ error: 'Title and Video File are required.' });
    }

    try {
        const found = await findParentAndPrimaryStudent(userEmail);
        if (!found) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const relativeUrl = `/uploads/${req.file.filename}`;
        await prisma.studentImprovementVideo.create({
            data: { studentId: found.student.id, title, url: relativeUrl },
        });

        const videos = await prisma.studentImprovementVideo.findMany({
            where: { studentId: found.student.id },
            orderBy: { addedAt: 'desc' },
        });

        res.status(201).json({
            message: 'Video uploaded successfully',
            videos: videos.map((v) => ({ id: v.id, title: v.title, url: v.url, addedAt: v.addedAt })),
        });
    } catch (err) {
        console.error('Error uploading improvement video:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get all student improvements (Admin access)
app.get('/api/admin/improvements', requireAdminAuth(['ADMIN', 'STAFF', 'SUPER_ADMIN']), async (req, res) => {
    try {
        const videos = await prisma.studentImprovementVideo.findMany({
            orderBy: { addedAt: 'desc' },
            include: {
                student: {
                    include: {
                        enrollments: {
                            orderBy: { createdAt: 'desc' },
                            take: 1,
                            include: { program: true },
                        },
                    },
                },
            },
        });

        const allVideos = videos.map((v) => ({
            studentName: v.student.fullName,
            programName: v.student.enrollments[0] ? v.student.enrollments[0].program.title : 'None Selected',
            videoTitle: v.title,
            videoUrl: v.url,
            addedAt: v.addedAt,
        }));

        res.json({ videos: allVideos });
    } catch (err) {
        console.error('Error fetching improvements:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ----------------------------------------------------------------------------
// Students list (Management/Company access)
// ----------------------------------------------------------------------------

app.get('/api/students', requireAdminAuth(['ADMIN', 'STAFF', 'SUPER_ADMIN']), async (req, res) => {
    try {
        const students = await prisma.student.findMany({
            orderBy: { createdAt: 'asc' },
            include: {
                enrollments: {
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                    include: { program: true },
                },
            },
        });

        const studentList = students.map((s) => ({
            id: s.id,
            name: s.fullName || 'Unknown Student',
            level: s.enrollments[0] ? s.enrollments[0].program.title : 'Level 1 Beginner',
            avatar: `https://i.pravatar.cc/120?img=${s.id.slice(-2)}`,
        }));
        res.json({ students: studentList });
    } catch (err) {
        console.error('Error fetching students:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ----------------------------------------------------------------------------
// Attendance
// ----------------------------------------------------------------------------

app.post('/api/attendance', requireAdminAuth(['ADMIN', 'STAFF', 'SUPER_ADMIN']), async (req, res) => {
    const { date, records } = req.body;
    if (!records) {
        return res.status(400).json({ error: 'Records are required' });
    }

    try {
        const sessionDate = date ? new Date(date) : new Date();
        const entries = Array.isArray(records) ? records : Object.values(records);

        const created = [];
        for (const record of entries) {
            const studentId = record.studentId || record.id;
            if (!studentId) continue;
            const student = await prisma.student.findUnique({ where: { id: String(studentId) } });
            if (!student) continue;

            const statusValue = (record.status || 'PRESENT').toUpperCase();
            const validStatus = ['PRESENT', 'ABSENT', 'LATE', 'EXCUSED'].includes(statusValue)
                ? statusValue
                : 'PRESENT';

            const row = await prisma.attendance
                .create({
                    data: { studentId: student.id, sessionDate, status: validStatus },
                })
                .catch((err) => {
                    if (err.code === 'P2002') return null; // duplicate, ignore
                    throw err;
                });
            if (row) created.push(row);
        }

        res.json({
            message: 'Attendance saved successfully',
            entry: { date: sessionDate, records, savedAt: new Date().toISOString() },
        });
    } catch (err) {
        console.error('Error saving attendance:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/attendance', requireAdminAuth(['ADMIN', 'STAFF', 'SUPER_ADMIN']), async (req, res) => {
    try {
        const rows = await prisma.attendance.findMany({
            orderBy: { sessionDate: 'desc' },
            include: { student: true },
        });

        const byDate = new Map();
        for (const row of rows) {
            const key = row.sessionDate.toISOString();
            if (!byDate.has(key)) {
                byDate.set(key, { id: key, date: key, records: [], savedAt: key });
            }
            byDate.get(key).records.push({
                studentId: row.studentId,
                studentName: row.student.fullName,
                status: row.status,
            });
        }

        res.json({ attendance: Array.from(byDate.values()) });
    } catch (err) {
        console.error('Error fetching attendance:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ----------------------------------------------------------------------------
// Feedback
// ----------------------------------------------------------------------------

app.post('/api/feedback', async (req, res) => {
    const userEmail = req.signedCookies.userEmail;
    if (!userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const {
        academicPerformanceRating,
        comments,
        focus_concentration,
        creativity_imagination,
        intuition,
        immunity_health,
        social_confidence,
    } = req.body;
    const rating = parseInt(academicPerformanceRating, 10);

    if (Number.isNaN(rating) || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Valid academic performance rating (1-5) is required.' });
    }

    try {
        const found = await findParentAndPrimaryStudent(userEmail);
        if (!found) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const extra = {
            focus_concentration,
            creativity_imagination,
            intuition,
            immunity_health,
            social_confidence,
        };
        const combinedComments = [comments || '', `[extra] ${JSON.stringify(extra)}`]
            .filter(Boolean)
            .join('\n\n');

        const feedback = await prisma.feedback.create({
            data: {
                studentId: found.student.id,
                programId: found.enrollment ? found.enrollment.programId : null,
                rating,
                comments: combinedComments,
            },
        });

        res.status(201).json({
            message: 'Feedback submitted successfully',
            feedback: {
                id: feedback.id,
                studentId: feedback.studentId,
                studentName: found.student.fullName,
                parentEmail: found.parent.email,
                parentName: found.parent.fullName,
                enrolledProgram: found.enrollment ? found.enrollment.program.title : 'None Selected',
                academicPerformanceRating: feedback.rating,
                comments: comments || '',
                focus_concentration: focus_concentration || '',
                creativity_imagination: creativity_imagination || '',
                intuition: intuition || '',
                immunity_health: immunity_health || '',
                social_confidence: social_confidence || '',
                submittedAt: feedback.createdAt,
            },
        });
    } catch (err) {
        console.error('Error submitting feedback:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/admin/feedbacks', requireAdminAuth(['ADMIN', 'STAFF', 'SUPER_ADMIN']), async (req, res) => {
    try {
        const rows = await prisma.feedback.findMany({
            orderBy: { createdAt: 'desc' },
            include: { student: { include: { parent: true } }, program: true },
        });

        const feedbacks = rows.map((fb) => ({
            id: fb.id,
            studentId: fb.studentId,
            studentName: fb.student.fullName,
            parentEmail: fb.student.parent.email,
            parentName: fb.student.parent.fullName,
            enrolledProgram: fb.program ? fb.program.title : 'None Selected',
            academicPerformanceRating: fb.rating,
            comments: fb.comments || '',
            submittedAt: fb.createdAt,
        }));

        res.json({ feedbacks });
    } catch (err) {
        console.error('Error fetching feedbacks:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ----------------------------------------------------------------------------
// Payments (Razorpay)
// ----------------------------------------------------------------------------

let razorpayClient = null;
function getRazorpay() {
    if (razorpayClient) return razorpayClient;
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        return null;
    }
    const Razorpay = require('razorpay');
    razorpayClient = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    return razorpayClient;
}

app.post('/api/create-order', async (req, res) => {
    const { amount, currency } = req.body;
    if (!amount) {
        return res.status(400).json({ error: 'Amount is required.' });
    }

    const client = getRazorpay();
    if (!client) {
        return res.status(500).json({
            error: 'Payment gateway is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.',
        });
    }

    try {
        const order = await client.orders.create({
            amount,
            currency: currency || 'INR',
            receipt: `rcpt_${Date.now()}`,
        });
        res.json({
            order_id: order.id,
            amount: order.amount,
            currency: order.currency,
            key_id: process.env.RAZORPAY_KEY_ID,
        });
    } catch (err) {
        console.error('Error creating Razorpay order:', err);
        res.status(500).json({ error: 'Failed to create payment order' });
    }
});

app.post('/api/verify-payment', async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: 'Missing payment verification fields.' });
    }
    if (!process.env.RAZORPAY_KEY_SECRET) {
        return res.status(500).json({ error: 'Payment gateway is not configured.' });
    }

    try {
        const crypto = require('crypto');
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ error: 'Signature verification failed' });
        }

        await prisma.payment.updateMany({
            where: { razorpayOrderId: razorpay_order_id },
            data: {
                razorpayPaymentId: razorpay_payment_id,
                status: 'SUCCESS',
                paymentDate: new Date(),
            },
        });

        res.json({ message: 'Payment verified successfully', verified: true });
    } catch (err) {
        console.error('Error verifying payment:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ----------------------------------------------------------------------------
// Admin Student Database Management (Excel Import & Central DB)
// ----------------------------------------------------------------------------

app.post('/api/admin/import-students', requireAdminAuth(['ADMIN', 'SUPER_ADMIN']), upload.single('excelFile'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Excel file is required.' });
    }

    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = xlsx.utils.sheet_to_json(sheet);

        let totalRows = rows.length;
        let successCount = 0;
        let failedCount = 0;
        const errors = [];

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowNumber = i + 2; // Row number in Excel sheet

            const studentName = row['Student Name'];
            const ageVal = parseInt(row['Age'], 10);
            const genderVal = row['Gender'];
            const gradeVal = row['Grade'];
            const schoolVal = row['School'];
            const parentName = row['Parent Name'];
            const addressVal = row['Address'];
            const mobileVal = row['Mobile Number'] ? String(row['Mobile Number']).trim() : '';
            const emailVal = row['Email'] ? String(row['Email']).trim() : '';
            const specialNeed = row['Special need'];

            // Validation
            if (!studentName) {
                failedCount++;
                errors.push({ row: rowNumber, name: studentName || 'Unknown Student', reason: 'Student Name is required.' });
                continue;
            }
            if (!parentName) {
                failedCount++;
                errors.push({ row: rowNumber, name: studentName, reason: 'Parent Name is required.' });
                continue;
            }
            if (!emailVal && !mobileVal) {
                failedCount++;
                errors.push({ row: rowNumber, name: studentName, reason: 'Either Parent Email or Mobile Number is required.' });
                continue;
            }

            try {
                let parent = null;
                const hasValidEmail = emailVal && emailVal !== '-';
                if (hasValidEmail) {
                    parent = await prisma.parent.findUnique({ where: { email: emailVal } });
                }

                if (!parent && mobileVal) {
                    parent = await prisma.parent.findFirst({ where: { mobile: mobileVal } });
                }

                if (!parent) {
                    const defaultPasswordHash = await bcrypt.hash('ChangeMe123!', 12);
                    const emailToUse = hasValidEmail ? emailVal : `parent_${mobileVal || Date.now()}@awakeniq.local`;
                    parent = await prisma.parent.create({
                        data: {
                            fullName: parentName,
                            relationship: 'guardian',
                            mobile: mobileVal || '0000000000',
                            email: emailToUse,
                            passwordHash: defaultPasswordHash,
                            residentialAddress: addressVal || '',
                            city: addressVal || '',
                            state: '',
                            pincode: ''
                        }
                    });
                }

                const genderEnum = toGenderEnum(genderVal);
                const studentAge = isNaN(ageVal) ? 8 : ageVal;
                const dateOfBirth = new Date(new Date().getFullYear() - studentAge, 0, 1);

                let student = await prisma.student.findFirst({
                    where: {
                        parentId: parent.id,
                        fullName: studentName
                    }
                });

                if (student) {
                    await prisma.student.update({
                        where: { id: student.id },
                        data: {
                            dateOfBirth,
                            gender: genderEnum,
                            classGrade: gradeVal ? String(gradeVal) : '',
                            schoolName: schoolVal || '',
                            hasSpecialNeeds: specialNeed && String(specialNeed).toUpperCase() !== 'NO',
                            specialNeedsDescription: specialNeed && String(specialNeed).toUpperCase() !== 'NO' ? String(specialNeed) : null
                        }
                    });
                } else {
                    await prisma.student.create({
                        data: {
                            parentId: parent.id,
                            fullName: studentName,
                            dateOfBirth,
                            gender: genderEnum,
                            classGrade: gradeVal ? String(gradeVal) : '',
                            schoolName: schoolVal || '',
                            hasSpecialNeeds: specialNeed && String(specialNeed).toUpperCase() !== 'NO',
                            specialNeedsDescription: specialNeed && String(specialNeed).toUpperCase() !== 'NO' ? String(specialNeed) : null
                        }
                    });
                }

                successCount++;
            } catch (innerErr) {
                console.error(`Error processing row ${rowNumber}:`, innerErr);
                failedCount++;
                errors.push({ row: rowNumber, name: studentName, reason: innerErr.message || 'Database error.' });
            }
        }

        fs.unlink(req.file.path, (err) => {
            if (err) console.error('Failed to delete uploaded Excel file:', err);
        });

        res.json({
            totalRows,
            successCount,
            failedCount,
            errors
        });
    } catch (err) {
        console.error('Failed to parse Excel file:', err);
        res.status(500).json({ error: 'Failed to process Excel file: ' + err.message });
    }
});

app.get('/api/admin/students-full', requireAdminAuth(['ADMIN', 'STAFF', 'SUPER_ADMIN']), async (req, res) => {
    try {
        const students = await prisma.student.findMany({
            orderBy: { createdAt: 'desc' },
            include: {
                parent: true,
                enrollments: {
                    orderBy: { createdAt: 'desc' },
                    include: {
                        program: true,
                        payments: { orderBy: { createdAt: 'desc' }, take: 1 }
                    }
                }
            }
        });

        const formatted = students.map(s => {
            const primaryEnrollment = s.enrollments[0] || null;
            const primaryPayment = primaryEnrollment && primaryEnrollment.payments[0] || null;

            let paymentStatus = 'N/A';
            if (primaryPayment) {
                paymentStatus = primaryPayment.status === 'SUCCESS' ? 'Paid' : 'Pending';
            } else if (primaryEnrollment) {
                paymentStatus = primaryEnrollment.status === 'PAID' ? 'Paid' : 'Pending';
            }

            const today = new Date();
            const birth = new Date(s.dateOfBirth);
            let age = today.getFullYear() - birth.getFullYear();
            const monthDiff = today.getMonth() - birth.getMonth();
            if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
                age--;
            }

            return {
                id: s.id,
                studentName: s.fullName,
                age: age,
                gender: s.gender.toLowerCase(),
                grade: s.classGrade || 'N/A',
                school: s.schoolName || 'N/A',
                parentName: s.parent.fullName,
                mobile: s.parent.mobile || 'N/A',
                email: s.parent.email,
                address: s.parent.residentialAddress || 'N/A',
                programName: primaryEnrollment ? primaryEnrollment.program.title : 'None Selected',
                paymentStatus: paymentStatus,
                specialNeeds: s.hasSpecialNeeds ? (s.specialNeedsDescription || 'YES') : 'NO'
            };
        });

        res.json({ students: formatted });
    } catch (err) {
        console.error('Error fetching student database:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ----------------------------------------------------------------------------
// Static frontend
// ----------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, '../frontend')));

app.listen(PORT, () => {
    console.log(`Awaken IQ Server running on http://localhost:${PORT}`);
    console.log('Datastore: PostgreSQL (Prisma) — JSON file storage has been removed.');
});
