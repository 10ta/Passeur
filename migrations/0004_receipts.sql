-- Delivery / seen marks on the latest admin message in a guest's topic (src/receipts.js).
ALTER TABLE users ADD COLUMN receipt_msg_id INTEGER;            -- admin's message in the topic carrying the mark
ALTER TABLE users ADD COLUMN receipt_seen INTEGER NOT NULL DEFAULT 0; -- 0 = 👌 delivered, 1 = 👀 guest wrote since
