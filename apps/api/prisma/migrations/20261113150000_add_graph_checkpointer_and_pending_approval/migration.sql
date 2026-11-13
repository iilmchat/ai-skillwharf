-- CreateTable
CREATE TABLE "GraphCheckpoint" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "checkpointNs" TEXT NOT NULL DEFAULT '',
    "checkpointId" TEXT NOT NULL,
    "parentCheckpointId" TEXT,
    "payload" BYTEA NOT NULL,
    "metadata" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GraphCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphCheckpointWrite" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "checkpointNs" TEXT NOT NULL DEFAULT '',
    "checkpointId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "taskPath" TEXT NOT NULL DEFAULT '',
    "channel" TEXT NOT NULL,
    "value" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GraphCheckpointWrite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingApproval" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "tools" JSONB NOT NULL,
    "holds" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "PendingApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GraphCheckpoint_threadId_checkpointId_idx" ON "GraphCheckpoint"("threadId", "checkpointId");

-- CreateIndex
CREATE UNIQUE INDEX "GraphCheckpoint_threadId_checkpointNs_checkpointId_key" ON "GraphCheckpoint"("threadId", "checkpointNs", "checkpointId");

-- CreateIndex
CREATE INDEX "GraphCheckpointWrite_threadId_checkpointNs_checkpointId_idx" ON "GraphCheckpointWrite"("threadId", "checkpointNs", "checkpointId");

-- CreateIndex
CREATE UNIQUE INDEX "GraphCheckpointWrite_threadId_checkpointNs_checkpointId_tas_key" ON "GraphCheckpointWrite"("threadId", "checkpointNs", "checkpointId", "taskId", "idx");

-- CreateIndex
CREATE UNIQUE INDEX "PendingApproval_conversationId_key" ON "PendingApproval"("conversationId");

-- CreateIndex
CREATE INDEX "PendingApproval_userId_status_createdAt_idx" ON "PendingApproval"("userId", "status", "createdAt");
