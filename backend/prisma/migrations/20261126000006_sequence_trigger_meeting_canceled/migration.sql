-- A sequence can start when a lead's booked meeting is canceled (the lead goes back to follow-up).
ALTER TYPE "sequence_trigger" ADD VALUE 'follow_up_appointment_canceled';
