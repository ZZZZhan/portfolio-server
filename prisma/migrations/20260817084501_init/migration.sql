-- CreateTable
CREATE TABLE "Probe" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Probe_pkey" PRIMARY KEY ("id")
);
