-- CreateTable
CREATE TABLE "SkillUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "callsCount" INTEGER NOT NULL DEFAULT 0,
    "lastResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SkillUsage_userId_idx" ON "SkillUsage"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SkillUsage_userId_skillName_key" ON "SkillUsage"("userId", "skillName");
