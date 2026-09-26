"""One-shot disposable certification. No shell evaluation or secret diagnostics."""
import os, stat, json, subprocess, resource, re, sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('/home/trace3smith/.fantasyedge-epoch-cert.env')
PRIOR=Path('/home/trace3smith/FantasyEdge/.cache/storage-epoch-cert-24b5c42/hosted-evidence.json')
NODE='/home/trace3smith/.nvm/versions/node/v24.16.0/bin/node'

def main():
    assert len(sys.argv)==1
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    assert not PRIVATE.is_relative_to(ROOT)
    for parent in PRIVATE.parents:
        s=parent.lstat()
        assert stat.S_ISDIR(s.st_mode) and s.st_uid in (0,os.getuid(),Path('/').lstat().st_uid) and not s.st_mode & 0o022
    assert PRIVATE.parent.lstat().st_uid==os.getuid()
    fd=os.open(PRIVATE,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        s=os.fstat(fd)
        assert stat.S_ISREG(s.st_mode) and s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1 and s.st_size<16384
        raw=os.read(fd,16384).decode()
    finally: os.close(fd)
    urls=['FE_EPOCH_CERT_REDIS_REST_URL','FE_EPOCH_CERT_REDIS_URL','EPOCH_CERT_REDIS_REST_URL','UPSTASH_REDIS_REST_URL','KV_REST_API_URL','REDIS_REST_URL']
    tokens=['FE_EPOCH_CERT_REDIS_REST_TOKEN','FE_EPOCH_CERT_REDIS_TOKEN','EPOCH_CERT_REDIS_REST_TOKEN','UPSTASH_REDIS_REST_TOKEN','KV_REST_API_TOKEN','REDIS_REST_TOKEN']
    keys=['ESPN_CREDENTIAL_ENCRYPTION_KEY','FE_EPOCH_CERT_ENCRYPTION_KEY','EPOCH_CERT_ENCRYPTION_KEY']
    values={}
    for line in raw.splitlines():
        if not line.strip() or line.lstrip().startswith('#'): continue
        if line.startswith('export '): line=line[7:]
        name,value=line.split('=',1)
        if len(value)>1 and value[0] in "\"'" and value[-1]==value[0]: value=value[1:-1]
        assert name in urls+tokens+keys and name not in values and re.fullmatch(r'[A-Za-z0-9_./:+?=&%-]+',value)
        values[name]=value
    def select(names):
        v={values[k] for k in names if k in values}
        assert len(v)==1
        return v.pop()
    previous=json.loads(PRIOR.read_text());assert previous['database']=='fantasyedge-epoch-cert'
    expected=previous['endpointIdentitySha256'];assert re.fullmatch('[a-f0-9]{64}',expected)
    env={'PATH':str(Path(NODE).parent)+':/usr/bin:/bin','CERT_URL':select(urls),'CERT_TOKEN':select(tokens),'CERT_EXPECTED_DIGEST':expected}
    # Only URL/token are injected; the existing certification encryption key is unused.
    evidence_path=ROOT/'.cache/lineup-accounting-certification/hosted-evidence.json'
    if evidence_path.exists(): evidence_path.unlink()
    r=subprocess.run([NODE,'--no-warnings','--experimental-test-module-mocks',str(ROOT/'scripts/certify-lineup-accounting.mjs')],env=env,cwd=ROOT,capture_output=True,timeout=900)
    evidence=json.loads(evidence_path.read_text())
    print(json.dumps({'passed':evidence.get('passed',False),'groups':evidence.get('groups',0),'cleanup':evidence.get('cleanup'),'stage':evidence.get('stage'),'failedCase':evidence.get('failedCase'),'commands':evidence.get('commands',{}),'childExit':r.returncode}))
    return 0 if r.returncode==0 and evidence.get('passed') and evidence.get('cleanup')=='PASS' else 1
try: sys.exit(main())
except SystemExit: raise
except BaseException:
    print('{"passed":false,"error":"FAIL_PRIVATE_CERT_LAUNCH"}')
    sys.exit(1)
