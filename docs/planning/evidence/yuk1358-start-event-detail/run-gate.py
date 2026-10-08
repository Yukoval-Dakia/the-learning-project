from pathlib import Path
import json, os, subprocess, sys, time
root = Path(__file__).resolve().parents[4]
evidence = Path(__file__).resolve().parent
name, *command = sys.argv[1:]
env = dict(os.environ)
env['PATH'] = '/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:' + env['PATH']
start = time.time()
with (evidence / (name + '.log')).open('w') as log:
    result = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
entry = {'name': name, 'command': command, 'cwd': str(root), 'exit_code': result.returncode, 'log': str(evidence / (name + '.log')), 'elapsed_seconds': round(time.time()-start, 3)}
with (evidence / 'commands.jsonl').open('a') as out:
    out.write(json.dumps(entry) + '\n')
print(json.dumps(entry))
sys.exit(result.returncode)
