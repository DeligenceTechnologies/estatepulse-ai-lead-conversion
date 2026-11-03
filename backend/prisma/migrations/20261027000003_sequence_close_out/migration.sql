-- Per sequence: how long a lead has to answer after the last step before the sequence closes out,
-- and whether a lead who stayed silent is then marked unresponsive. The defaults are the behaviour
-- every sequence had before: 48 hours, then unresponsive.
ALTER TABLE "sequences" ADD COLUMN "close_out_hours" INTEGER NOT NULL DEFAULT 48,
ADD COLUMN "close_out_unresponsive" BOOLEAN NOT NULL DEFAULT true;
