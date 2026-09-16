#!/usr/bin/env python3
"""API and rolling mock-inventory smoke test against a temporary SQLite DB."""
import json, os, sqlite3, subprocess, tempfile, time, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
PORT='8877'

def call(path,method='GET',data=None,token=None):
    headers={'Content-Type':'application/json'}
    if token:headers['Authorization']='Bearer '+token
    req=urllib.request.Request('http://127.0.0.1:'+PORT+path,data=json.dumps(data).encode() if data is not None else None,headers=headers,method=method)
    with urllib.request.urlopen(req,timeout=5) as r:return json.loads(r.read())

def month_start(value, offset):
    index=value.year*12+value.month-1+offset
    return value.replace(year=index//12,month=index%12+1,day=1)

with tempfile.TemporaryDirectory() as td:
    db_path=Path(td)/'test.db'
    env=os.environ.copy();env.update({'PORT':PORT,'ATOLLE_DB':str(db_path),'BML_MODE':'mock','ENFORCE_AUTH':'1'})
    p=subprocess.Popen(['python3','app.py'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        for _ in range(40):
            try:
                if call('/api/health')['ok']:break
            except Exception:time.sleep(.1)
        login=call('/api/auth/login','POST',{'email':'admin@atolle.mv','password':'AtolleAdmin123!'})
        token=login['token']
        yachts=call('/api/yachts?status=live')
        imported=[y for y in yachts if str(y.get('slug','')).startswith('liveaboard-')]
        assert len(imported)==42

        today=datetime.now(timezone(timedelta(hours=5))).date()
        for offset in range(36):
            start=max(today,month_start(today,offset))
            end=month_start(today,offset+1)-timedelta(days=1)
            found=call(f'/api/yachts?status=live&mode=shared&start={start}&end={end}&guests=2')
            assert len([y for y in found if str(y.get('slug','')).startswith('liveaboard-')])==42

        april=call('/api/yachts?status=live&mode=shared&start=2028-04-01&end=2028-04-30&guests=2')
        for yacht in april:
            matches=yacht.get('matching_departures',[])
            if any(not d['mock_generated'] for d in matches):assert not matches[0]['mock_generated']
        generated=call('/api/departures',token=token)
        sourced=call('/api/departures?include_generated=0',token=token)
        assert len(generated)>len(sourced) and len(sourced)==119
        assert sum(1 for d in sourced if str(d['start_date']).startswith('2028-04-'))==117

        with sqlite3.connect(db_path) as db:
            db.row_factory=sqlite3.Row
            rows=db.execute('''SELECT d.*,y.cabins yacht_cabins,y.guests yacht_guests,y.shared_rate
                               FROM departures d JOIN yachts y ON y.id=d.yacht_id
                               WHERE d.mock_generated=1 ORDER BY d.yacht_id,d.start_date''').fetchall()
            assert rows
            previous={}
            for d in rows:
                start=datetime.strptime(d['start_date'],'%Y-%m-%d').date()
                end=datetime.strptime(d['end_date'],'%Y-%m-%d').date()
                assert start.weekday()==0 and end-start==timedelta(days=7) and d['nights']==7
                assert d['cabins_total']==d['cabins_available']==d['yacht_cabins']
                assert d['places_total']==d['places_available']==d['yacht_guests']
                assert round(d['price_pp'],2)==round(d['shared_rate']*7,2)
                if d['yacht_id'] in previous:assert start-previous[d['yacht_id']]==timedelta(days=7)
                previous[d['yacht_id']]=start
            generated_count=len(rows)
            manually_closed_id=rows[-1]['id']
            db.execute("UPDATE departures SET status='closed' WHERE id=?",(manually_closed_id,))
            db.commit()

        shared=next(y for y in call(f'/api/yachts?status=live&mode=shared&start={today}&end={month_start(today,1)-timedelta(days=1)}&guests=2') if str(y.get('slug','')).startswith('liveaboard-'))
        dep=next(d for d in shared['matching_departures'] if d['mock_generated'])
        shared_booking=call('/api/bookings','POST',{'yacht_id':shared['id'],'departure_id':dep['id'],'mode':'shared','guest_name':'Shared Smoke','email':'shared@example.com','guests':2,'cabins_booked':1})
        assert shared_booking['total_amount']==round(dep['price_pp']*2,2)

        y=yachts[0]
        private_start=today+timedelta(days=120)
        private_end=private_start+timedelta(days=3)
        b=call('/api/bookings','POST',{'yacht_id':y['id'],'mode':'private','guest_name':'Smoke Test','email':'smoke@example.com','guests':2,'start_date':str(private_start),'end_date':str(private_end)})
        pay=call('/api/payments/create','POST',{'booking_id':b['id'],'payment_type':'deposit'},token)
        assert round(pay['commission_rate'],2)==30
        assert round(pay['commission_amount'],2)==round(pay['gross_amount']*.30,2)
        call('/api/payments/demo-complete','POST',{'payment_id':pay['payment_id'],'status':'paid'},token)
        detail=call('/api/bookings/'+str(b['id']))
        assert detail['payment_status'] in ('partial','paid')
        ledger=call('/api/admin/ledger',token=token)
        assert ledger and ledger[0]['available_balance']>0
        subprocess.run(['python3','-c','import app; app.init_db()'],cwd=ROOT,env=env,check=True)
        with sqlite3.connect(db_path) as db:
            assert db.execute('SELECT COUNT(*) FROM departures WHERE mock_generated=1').fetchone()[0]==generated_count
            assert db.execute('SELECT status FROM departures WHERE id=?',(manually_closed_id,)).fetchone()[0]=='closed'
        print('PASS: 36-month mock inventory, sourced departures, shared booking, auth, payment and ledger')
    finally:
        p.terminate();p.wait(timeout=5)
