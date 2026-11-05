#!/bin/bash
# Run by launchd. Restarts the NAS memory watchdog after a NAS reboot and raises an alert on a memory stop or a stopped
# TEST. Changes nothing on the NAS except starting my own watchdog. It cannot run while the Mac is off.
D="$HOME/Library/Application Support/tlp-nas-tunnel"; LOG="$D/nas-watch.log"; ALERT="$D/ALERT"
NAS=(/usr/bin/ssh -n -F none -i "$HOME/.ssh/tlp_nas_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR yukoval@bancho-nb2.local)
L=/volume1/docker/tlp-test/_load
log(){ echo "$(date '+%F %T') $1" >> "$LOG"; }
alert(){ if [ ! -e "$ALERT" ] || [ "$(cat "$ALERT")" != "$1" ]; then printf '%s' "$1" > "$ALERT"; log "ALERT $1"; /usr/bin/osascript -e "display notification \"$1\" with title \"TEST on NAS\"" >/dev/null 2>&1; fi; }
miss=0
while :; do
  r=$("${NAS[@]}" "if [ -e $L/MEMORY_STOP ]; then echo STOP; elif pgrep -f '^/bin/bash ./watchdog.sh' >/dev/null; then echo ok; else echo gone; fi; docker ps --filter name=the-learning-project- --filter health=healthy -q 2>/dev/null | wc -l" 2>/dev/null)
  if [ -z "$r" ]; then
    miss=$((miss+1)); [ $miss -ge 6 ] && alert "NAS not answering"
  else
    miss=0; state=$(echo "$r" | sed -n 1p); up=$(echo "$r" | sed -n 2p | tr -d ' ')
    case "$state" in
      STOP) alert "memory stop fired on the NAS" ;;
      gone) "${NAS[@]}" "cd $L; nohup setsid ./watchdog.sh >/dev/null 2>&1 < /dev/null & sleep 1" && log "watchdog restarted, TEST healthy containers=$up" ;;
      ok) if [ "$up" = 4 ]; then [ -e "$ALERT" ] && { log "alert cleared: $(cat "$ALERT")"; rm -f "$ALERT"; }; else alert "TEST healthy containers=$up of 4"; fi ;;
    esac
  fi
  /bin/sleep 20
done
