-- Staging-only demo access. Do not apply this file to production databases.
UPDATE users
SET password_hash = CASE email
  WHEN 'admin@atolle.mv' THEN '100000$pT7jaBpdCzOUZE210qbCAg==$aq5erft4qjlvrmhF/6ZhWsD+VJQ9VEOacr752DVlPE8='
  WHEN 'operator@example.com' THEN '100000$Z1T2qir+1H8Zp4r8IPjoUg==$U7VyZJ1yzR++UmfGxVFTMTdm68NJtJJZVBjNw5/lIeM='
  WHEN 'guest@example.com' THEN '100000$5WsQX7TuoCriCbYg8rDQyQ==$SBxvdwuqT6VIOK85wujex6o+Tk0DHLihiemAW6FNXJo='
END,
active = 1
WHERE email IN ('admin@atolle.mv', 'operator@example.com', 'guest@example.com');

DELETE FROM sessions
WHERE user_id IN (
  SELECT id FROM users
  WHERE email IN ('admin@atolle.mv', 'operator@example.com', 'guest@example.com')
);
