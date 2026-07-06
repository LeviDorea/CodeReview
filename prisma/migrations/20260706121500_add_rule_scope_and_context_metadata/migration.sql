-- CreateEnum
CREATE TYPE "RuleScope" AS ENUM ('file', 'pr');

-- AlterTable
ALTER TABLE "Rule"
ADD COLUMN "scope" "RuleScope" NOT NULL DEFAULT 'file',
ADD COLUMN "whyThisRuleExists" TEXT,
ADD COLUMN "localEvidence" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
