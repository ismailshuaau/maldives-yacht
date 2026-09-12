#!/usr/bin/env python3
"""Basic API smoke test. Starts app.py against a temporary SQLite DB."""
import json, os, subprocess, tempfile, time, urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
PORT='8877'

def call(path,method='GET',data=None,token=None):
    headers={'Content-Type':'application/json'}
    if token:headers['Authorization']='Bearer '+token
    req=urllib.request.Request('http://127.0.0.1:'+PORT+path,data=json.dumps(data).encode() if data is not None else None,headers=headers,method=method)
    with urllib.request.urlopen(req,timeout=5) as r:return json.loads(r.read())

with tempfile.TemporaryDirectory() as td:
    env=os.environ.copy();env.update({'PORT':PORT,'ATOLLE_DB':str(Path(td)/'test.db'),'BML_MODE':'mock','ENFORCE_AUTH':'1'})
    p=subprocess.Popen(['python3','app.py'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        for _ in range(40):
            try:
                if call('/api/health')['ok']:break
            except Exception:time.sleep(.1)
        login=call('/api/auth/login','POST',{'email':'admin@atolle.mv','password':'AtolleAdmin123!'})
        token=login['token']
        yachts=call('/api/yachts?status=live')
        y=yachts[0]
        b=call('/api/bookings','POST',{'yacht_id':y['id'],'mode':'private','guest_name':'Smoke Test','email':'smoke@example.com','guests':2,'start_date':'2026-12-01','end_date':'2026-12-04'})
        pay=call('/api/payments/create','POST',{'booking_id':b['id'],'payment_type':'deposit'},token)
        assert round(pay['commission_rate'],2)==30
        assert round(pay['commission_amount'],2)==round(pay['gross_amount']*.30,2)
        call('/api/payments/demo-complete','POST',{'payment_id':pay['payment_id'],'status':'paid'},token)
        detail=call('/api/bookings/'+str(b['id']))
        assert detail['payment_status'] in ('partial','paid')
        ledger=call('/api/admin/ledger',token=token)
        assert ledger and ledger[0]['available_balance']>0
        print('PASS: auth, booking, availability hold, deposit, BML mock payment, 30% commission and operator ledger')
    finally:
        p.terminate();p.wait(timeout=5)
