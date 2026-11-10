-- Topic status icon: 1 while the guest's latest message is unanswered (src/status.js).
ALTER TABLE users ADD COLUMN waiting INTEGER NOT NULL DEFAULT 0;
-- Where the guest came from: the payload of their first /start <source> link.
ALTER TABLE users ADD COLUMN source TEXT;
