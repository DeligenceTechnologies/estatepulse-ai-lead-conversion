-- Remove the two seeded sequences. An office now starts with none and authors
-- its own in the editor.
--
-- The application used to create WARM_NURTURE and COLD_REACTIVATION on demand
-- the first time anyone opened the Follow-ups screen. That code is gone, but
-- any database where the screen was opened already has the rows, and they
-- would sit there forever with nothing to recreate or explain them. This makes
-- every environment match the code.
--
-- Guarded twice, because this deletes data:
--
--   * only the two codes the application itself seeded — a sequence somebody
--     authored is never touched, whatever it is called;
--   * only where NOTHING has ever been enrolled. An enrolment is the record of
--     why a real person did or did not get texted, and sequence_enrollments
--     cascades from here, so a sequence that has been used is left exactly
--     where it is. If any survive, they are visible in the editor and can be
--     archived by hand.
--
-- sequence_steps cascades, so deleting the parent is enough.
DELETE FROM followup_sequences fs
 WHERE fs.code IN ('WARM_NURTURE', 'COLD_REACTIVATION')
   AND NOT EXISTS (
     SELECT 1 FROM sequence_enrollments se WHERE se.sequence_id = fs.id
   );
