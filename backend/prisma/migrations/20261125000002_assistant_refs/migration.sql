-- CreateTable
CREATE TABLE "assistant_refs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "entity_type" VARCHAR(20) NOT NULL,
    "entity_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_refs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assistant_refs_thread_id_entity_type_number_key" ON "assistant_refs"("thread_id", "entity_type", "number");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_refs_thread_id_entity_type_entity_id_key" ON "assistant_refs"("thread_id", "entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "assistant_refs" ADD CONSTRAINT "assistant_refs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_refs" ADD CONSTRAINT "assistant_refs_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "assistant_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
