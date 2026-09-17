// The frontend was built against a flat "user" object (one row combining
// student + parent + program + payment fields) and is not being modified.
// These helpers translate between that flat shape and the normalized
// Parent / Student / Enrollment / Payment tables, so every endpoint can keep
// returning exactly what the frontend already expects.

// dd/mm/yyyy -> Date. Falls back to null if unparseable.
function parseDdMmYyyy(value) {
    if (!value || typeof value !== 'string') return null;
    const parts = value.split('/');
    if (parts.length !== 3) return null;
    const [dd, mm, yyyy] = parts.map((p) => parseInt(p, 10));
    if (!dd || !mm || !yyyy) return null;
    const date = new Date(Date.UTC(yyyy, mm - 1, dd));
    return Number.isNaN(date.getTime()) ? null : date;
}

function calcAge(dateOfBirth) {
    if (!dateOfBirth) return null;
    const today = new Date();
    const birth = new Date(dateOfBirth);
    let age = today.getUTCFullYear() - birth.getUTCFullYear();
    const monthDiff = today.getUTCMonth() - birth.getUTCMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getUTCDate() < birth.getUTCDate())) {
        age -= 1;
    }
    return age;
}

function toGenderEnum(value) {
    const v = (value || '').toLowerCase();
    if (v === 'male') return 'MALE';
    if (v === 'female') return 'FEMALE';
    return 'OTHER';
}

function fromGenderEnum(value) {
    return (value || '').toLowerCase();
}

// Parses "$1,652.00" / "1652" / 1652 -> 1652.00 number
function parseCurrency(value) {
    if (typeof value === 'number') return value;
    if (!value) return 0;
    const cleaned = String(value).replace(/[^0-9.]/g, '');
    const num = parseFloat(cleaned);
    return Number.isNaN(num) ? 0 : num;
}

// Builds the flat legacy "user" object the frontend already knows how to
// render (dashboard.html, my-courses.html, course-*.html, etc). Pulls the
// most recent enrollment + payment for program/billing fields.
function buildLegacyUser({ parent, student, enrollment, payment, videos, feedbacks }) {
    return {
        id: student.id,

        // Student Info
        studentName: student.fullName,
        studentAge: calcAge(student.dateOfBirth) !== null ? String(calcAge(student.dateOfBirth)) : '',
        studentGender: fromGenderEnum(student.gender),
        studentGrade: student.classGrade,
        studentSchool: student.schoolName,
        studentSpecialNeeds: student.hasSpecialNeeds,
        studentSpecialDetails: student.specialNeedsDescription || '',

        // Parent Info
        parentName: parent.fullName,
        parentRelationship: parent.relationship,
        parentMobile: parent.mobile,
        parentAltMobile: parent.alternateMobile || '',
        parentEmail: parent.email,
        parentAddress: parent.residentialAddress,
        parentCity: parent.city,
        parentState: parent.state,
        parentPincode: parent.pincode,

        // Program & Payment Info
        enrolledProgram: enrollment ? enrollment.program.title : 'None Selected',
        duration: enrollment ? enrollment.program.durationText : '',
        paymentStatus: payment ? mapPaymentStatusToLegacy(payment.status) : 'Pending',
        paymentMethod: payment ? payment.gateway : 'Credit/Debit',

        registrationDate: student.createdAt,

        videos: (videos || []).map((v) => ({
            id: v.id,
            title: v.title,
            url: v.url,
            addedAt: v.addedAt,
        })),
        feedbacks: (feedbacks || []).map(mapFeedbackToLegacy),
    };
}

function mapPaymentStatusToLegacy(status) {
    switch (status) {
        case 'SUCCESS':
            return 'Paid';
        case 'FAILED':
            return 'Failed';
        case 'REFUNDED':
            return 'Refunded';
        default:
            return 'Pending';
    }
}

function mapFeedbackToLegacy(fb) {
    return {
        id: fb.id,
        studentId: fb.studentId,
        academicPerformanceRating: fb.rating,
        comments: fb.comments || '',
        submittedAt: fb.createdAt,
    };
}

function slugify(title) {
    return title
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

module.exports = {
    parseDdMmYyyy,
    calcAge,
    toGenderEnum,
    fromGenderEnum,
    parseCurrency,
    buildLegacyUser,
    mapPaymentStatusToLegacy,
    mapFeedbackToLegacy,
    slugify,
};
