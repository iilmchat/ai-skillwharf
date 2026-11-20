-- Sprint 38: база знаний — папки и метаданные чанков для сносок (KB-38.1/38.2).

CREATE TABLE "KnowledgeFolder" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeFolder_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "KnowledgeFolder_userId_idx" ON "KnowledgeFolder"("userId");
CREATE INDEX "KnowledgeFolder_workspaceId_idx" ON "KnowledgeFolder"("workspaceId");

ALTER TABLE "MemoryChunk" ADD COLUMN "folderId" TEXT;
ALTER TABLE "MemoryChunk" ADD COLUMN "documentTitle" TEXT;
ALTER TABLE "MemoryChunk" ADD COLUMN "pageNumber" INTEGER;
CREATE INDEX "MemoryChunk_folderId_idx" ON "MemoryChunk"("folderId");
