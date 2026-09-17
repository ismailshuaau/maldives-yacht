INSERT INTO vendors(id,name,email,status,verified,created_at) VALUES
 (1,'Test Operator','operator@example.com','verified',1,datetime('now')),
 (2,'Other Operator','other@example.com','pending',0,datetime('now'));
INSERT INTO users(id,vendor_id,name,email,password_hash,role,active,created_at) VALUES
 (1,1,'Test Operator','operator@example.com','100000$Z1T2qir+1H8Zp4r8IPjoUg==$U7VyZJ1yzR++UmfGxVFTMTdm68NJtJJZVBjNw5/lIeM=','vendor',1,datetime('now')),
 (2,NULL,'Test Admin','admin@atolle.mv','100000$pT7jaBpdCzOUZE210qbCAg==$aq5erft4qjlvrmhF/6ZhWsD+VJQ9VEOacr752DVlPE8=','admin',1,datetime('now'));
INSERT INTO yachts(id,vendor_id,name,slug,type,status,private_enabled,shared_enabled,guests,cabins,crew,length_m,private_rate,shared_rate,verified,updated_at) VALUES
 (1,1,'Test Yacht','test-yacht','Liveaboard','live',1,1,12,6,4,30,1000,300,1,datetime('now')),
 (2,2,'Private Draft','private-draft','Motor Yacht','draft',1,0,4,2,2,20,500,NULL,0,datetime('now'));
INSERT INTO departures(id,yacht_id,title,start_date,end_date,nights,cabins_total,cabins_available,places_total,places_available,price_pp,status,mock_generated) VALUES(1,1,'Test Departure',date('now','+90 days'),date('now','+95 days'),5,6,6,12,12,300,'open',0);
INSERT INTO enquiries(yacht_id,guest_name,email,guests,status,created_at) VALUES
 (1,'Own Guest','own@example.com',2,'new',datetime('now')),
 (2,'Other Guest','other-guest@example.com',2,'new',datetime('now'));
INSERT INTO platform_settings(key,value,updated_at) VALUES
 ('deposit_percent','30',datetime('now')),
 ('commission_rate','30',datetime('now')),
 ('hold_minutes','30',datetime('now')),
 ('currency','USD',datetime('now'));

WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<14)
INSERT INTO yachts(id,vendor_id,name,slug,type,status,private_enabled,shared_enabled,guests,cabins,crew,length_m,description,image,private_rate,shared_rate,amenities_json,experiences_json,rating,reviews,verified,updated_at)
SELECT 100+n,1,'Search Yacht '||printf('%02d',n),'search-yacht-'||n,
  CASE WHEN n%2=0 THEN 'Motor Yacht' ELSE 'Liveaboard' END,'live',1,1,20,10,5,32,
  'A yacht used to verify cursor pagination.','https://example.com/yacht-'||n||'.jpg',1200,250,
  '["Nitrox","Wi-Fi"]',CASE WHEN n%2=0 THEN '["Diving"]' ELSE '["Diving","Luxury escape"]' END,
  4.9-(n/100.0),n,1,datetime('now') FROM seq;

WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<14)
INSERT INTO departures(id,yacht_id,title,start_date,end_date,nights,cabins_total,cabins_available,places_total,places_available,price_pp,status,mock_generated)
SELECT 100+n,100+n,'Search Departure '||n,date('now','+90 days'),date('now','+95 days'),5,10,10,20,20,1250,'open',0 FROM seq;

INSERT INTO bookings(id,booking_ref,yacht_id,departure_id,mode,guest_name,email,guests,start_date,end_date,nights,total_amount,status,expires_at,created_at,updated_at)
VALUES(90,'EXPIRED-SEARCH-HOLD',1,1,'shared','Expired Hold','expired@example.com',12,date('now','+90 days'),date('now','+95 days'),5,3600,'cancelled',datetime('now','-1 hour'),datetime('now','-2 hours'),datetime('now','-2 hours'));
INSERT INTO availability_holds(id,booking_id,yacht_id,departure_id,start_date,end_date,units,cabin_units,expires_at,status,created_at)
VALUES(90,90,1,1,date('now','+90 days'),date('now','+95 days'),12,6,datetime('now','-1 hour'),'active',datetime('now','-2 hours'));

-- Yacht 1 is the fixture used by private booking/payment tests.
UPDATE yachts SET private_rate_public=1,private_instant_booking=1 WHERE id=1;
