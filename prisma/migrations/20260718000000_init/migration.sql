-- ============================================================================
-- AwakenIQ — LMS & Student Enrollment Portal
-- Migration 001: Initial normalized schema (PostgreSQL / Neon)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ----------------------------------------------------------------------------
-- ENUM TYPES
-- ----------------------------------------------------------------------------
CREATE TYPE admin_role AS ENUM ('SUPER_ADMIN', 'ADMIN', 'SUPPORT');
CREATE TYPE gender AS ENUM ('MALE', 'FEMALE', 'OTHER');
CREATE TYPE program_status AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE enrollment_status AS ENUM
  ('DRAFT', 'SUBMITTED', 'PENDING_PAYMENT', 'PAID', 'APPROVED', 'REJECTED', 'CANCELLED');
CREATE TYPE access_type AS ENUM ('FULL', 'PARTIAL', 'MODULE_BASED', 'TIME_BASED');
CREATE TYPE payment_status AS ENUM ('INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'REFUNDED');
CREATE TYPE payment_gateway AS ENUM ('RAZORPAY', 'MANUAL', 'OTHER');
CREATE TYPE attendance_status AS ENUM ('PRESENT', 'ABSENT', 'LATE', 'EXCUSED');
CREATE TYPE discount_type AS ENUM ('FLAT', 'PERCENTAGE');

-- ----------------------------------------------------------------------------
-- ADMINS
-- ----------------------------------------------------------------------------
CREATE TABLE admins (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          admin_role NOT NULL DEFAULT 'ADMIN',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX idx_admins_email ON admins (email);

-- ----------------------------------------------------------------------------
-- PARENTS
-- ----------------------------------------------------------------------------
CREATE TABLE parents (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name            TEXT NOT NULL,
  relationship         TEXT NOT NULL,
  mobile               TEXT NOT NULL,
  alternate_mobile     TEXT,
  email                TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  residential_address  TEXT NOT NULL,
  city                 TEXT NOT NULL,
  state                TEXT NOT NULL,
  pincode              TEXT NOT NULL,
  is_email_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ
);
CREATE INDEX idx_parents_email ON parents (email);
CREATE INDEX idx_parents_mobile ON parents (mobile);

-- ----------------------------------------------------------------------------
-- STUDENTS  (one parent -> many students)
-- ----------------------------------------------------------------------------
CREATE TABLE students (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id                 UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  full_name                 TEXT NOT NULL,
  date_of_birth             DATE NOT NULL,
  gender                    gender NOT NULL,
  class_grade               TEXT NOT NULL,
  school_name               TEXT NOT NULL,
  has_special_needs         BOOLEAN NOT NULL DEFAULT FALSE,
  special_needs_description TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at                TIMESTAMPTZ,
  CONSTRAINT chk_special_needs_desc
    CHECK (has_special_needs = FALSE OR special_needs_description IS NOT NULL)
);
CREATE INDEX idx_students_parent_id ON students (parent_id);

-- ----------------------------------------------------------------------------
-- PROGRAMS & LESSONS
-- ----------------------------------------------------------------------------
CREATE TABLE programs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title             TEXT NOT NULL,
  slug              TEXT NOT NULL UNIQUE,
  description       TEXT NOT NULL,
  duration_text     TEXT NOT NULL,
  age_group         TEXT NOT NULL,
  price             NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  registration_fee  NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (registration_fee >= 0),
  gst_percentage    NUMERIC(5,2)  NOT NULL DEFAULT 18 CHECK (gst_percentage >= 0),
  materials_fee     NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (materials_fee >= 0),
  thumbnail_url     TEXT,
  syllabus_pdf_url  TEXT,
  status            program_status NOT NULL DEFAULT 'DRAFT',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);
CREATE INDEX idx_programs_status ON programs (status);

CREATE TABLE lessons (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id       UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT,
  bunny_video_id   TEXT NOT NULL,
  lesson_order     INT NOT NULL,
  duration_seconds INT NOT NULL CHECK (duration_seconds >= 0),
  is_free          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  UNIQUE (program_id, lesson_order)
);
CREATE INDEX idx_lessons_program_id ON lessons (program_id);

-- ----------------------------------------------------------------------------
-- ENROLLMENTS
-- ----------------------------------------------------------------------------
CREATE TABLE enrollments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  program_id       UUID NOT NULL REFERENCES programs(id) ON DELETE RESTRICT,
  status           enrollment_status NOT NULL DEFAULT 'DRAFT',
  access_type      access_type NOT NULL DEFAULT 'FULL',
  enrollment_date  TIMESTAMPTZ,
  access_start     TIMESTAMPTZ,
  access_end       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  UNIQUE (student_id, program_id)
);
CREATE INDEX idx_enrollments_status ON enrollments (status);
CREATE INDEX idx_enrollments_student_id ON enrollments (student_id);

CREATE TABLE enrollment_lesson_access (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id  UUID NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  lesson_id      UUID NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  access_granted BOOLEAN NOT NULL DEFAULT TRUE,
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ,
  UNIQUE (enrollment_id, lesson_id)
);

-- ----------------------------------------------------------------------------
-- COUPONS & PAYMENTS
-- ----------------------------------------------------------------------------
CREATE TABLE coupons (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT NOT NULL UNIQUE,
  discount_type  discount_type NOT NULL,
  discount_value NUMERIC(10,2) NOT NULL CHECK (discount_value >= 0),
  valid_from     TIMESTAMPTZ NOT NULL,
  valid_to       TIMESTAMPTZ NOT NULL,
  max_uses       INT,
  used_count     INT NOT NULL DEFAULT 0,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ,
  CONSTRAINT chk_coupon_dates CHECK (valid_to >= valid_from)
);

CREATE TABLE payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id           UUID NOT NULL REFERENCES parents(id) ON DELETE RESTRICT,
  student_id          UUID NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  program_id          UUID NOT NULL REFERENCES programs(id) ON DELETE RESTRICT,
  enrollment_id       UUID NOT NULL REFERENCES enrollments(id) ON DELETE RESTRICT,
  amount              NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  registration_fee    NUMERIC(10,2) NOT NULL DEFAULT 0,
  gst_amount          NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount_amount     NUMERIC(10,2) NOT NULL DEFAULT 0,
  coupon_id           UUID REFERENCES coupons(id) ON DELETE SET NULL,
  total_payable       NUMERIC(10,2) NOT NULL CHECK (total_payable >= 0),
  currency            TEXT NOT NULL DEFAULT 'INR',
  gateway             payment_gateway NOT NULL DEFAULT 'RAZORPAY',
  razorpay_order_id   TEXT,
  razorpay_payment_id TEXT,
  transaction_id      TEXT,
  status              payment_status NOT NULL DEFAULT 'INITIATED',
  payment_date        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_parent_id ON payments (parent_id);
CREATE INDEX idx_payments_student_id ON payments (student_id);
CREATE INDEX idx_payments_enrollment_id ON payments (enrollment_id);
CREATE INDEX idx_payments_razorpay_order_id ON payments (razorpay_order_id);
CREATE INDEX idx_payments_razorpay_payment_id ON payments (razorpay_payment_id);
CREATE INDEX idx_payments_status ON payments (status);

-- ----------------------------------------------------------------------------
-- PROGRESS / ATTENDANCE / FEEDBACK / CERTIFICATES
-- ----------------------------------------------------------------------------
CREATE TABLE video_progress (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id            UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  lesson_id             UUID NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  watch_percentage      NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (watch_percentage BETWEEN 0 AND 100),
  completed             BOOLEAN NOT NULL DEFAULT FALSE,
  last_position_seconds INT NOT NULL DEFAULT 0,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, lesson_id)
);
CREATE INDEX idx_video_progress_student_id ON video_progress (student_id);

CREATE TABLE attendance (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  program_id   UUID REFERENCES programs(id) ON DELETE SET NULL,
  session_date DATE NOT NULL,
  status       attendance_status NOT NULL,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, program_id, session_date)
);
CREATE INDEX idx_attendance_student_id ON attendance (student_id);

CREATE TABLE feedback (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  program_id UUID REFERENCES programs(id) ON DELETE SET NULL,
  rating     INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comments   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_feedback_student_id ON feedback (student_id);
CREATE INDEX idx_feedback_program_id ON feedback (program_id);

CREATE TABLE certificates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id         UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  program_id         UUID NOT NULL REFERENCES programs(id) ON DELETE RESTRICT,
  certificate_number TEXT NOT NULL UNIQUE,
  certificate_url    TEXT NOT NULL,
  issued_date        DATE NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, program_id)
);
CREATE INDEX idx_certificates_student_id ON certificates (student_id);

-- ----------------------------------------------------------------------------
-- STUDENT IMPROVEMENT VIDEOS
-- ----------------------------------------------------------------------------
CREATE TABLE student_improvement_videos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  url        TEXT NOT NULL,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_student_improvement_videos_student_id ON student_improvement_videos (student_id);

-- ----------------------------------------------------------------------------
-- updated_at trigger
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['admins','parents','students','programs','lessons',
      'enrollments','coupons','payments','video_progress','attendance',
      'feedback','certificates'])
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at();', t, t);
  END LOOP;
END $$;
