-- CreateIndex
CREATE INDEX "Complaint_title_idx" ON "Complaint" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Complaint_description_idx" ON "Complaint" USING GIN ("description" gin_trgm_ops);
