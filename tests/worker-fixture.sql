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
