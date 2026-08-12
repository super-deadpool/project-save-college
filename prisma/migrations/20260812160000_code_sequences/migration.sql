-- Human-readable codes: CMP-0001 / INC-001. A Postgres sequence keeps them
-- unique without a read-modify-write race in application code.
CREATE SEQUENCE IF NOT EXISTS complaint_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS incident_code_seq START 1;
