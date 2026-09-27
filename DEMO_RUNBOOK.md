# Demo runbook

**Not a document to read during the demo. Read it before, and again the night
before.** Everything here is a decision made in advance, because the whole point is
that nothing important is decided while an audience is watching.

---

## 1. The one hard rule

**If anything is wrong in the first 60 seconds, stop and play `demo.mp4`.**

No live debugging. No "let me just try one more thing". The 90-second video covers
the same ground and it cannot fail. Reaching for a keyboard because a tap missed is
how a 4-minute demo becomes a 15-minute one.

The video is not a backup for a broken build. It is the normal ending to a bad
start, and treating it that way is what makes it usable without hesitation.

---

## 1a. Run the gate

```bash
./demo-freeze.sh
```

It re-runs every automated check and then verifies the things that are easy to
skip: that `demo.mp4` exists and is not a placeholder, that the relay is live,
that the install link still resolves, and that the enrollment sheet has no
unfilled screenshot gaps.

**It fails while `demo.mp4` is missing.** That is deliberate. The fallback ladder
has to be complete before you are on stage, and the only reliable time to discover
it is incomplete is before you are on stage.

It also prints a manual checklist. Nothing on that list can be verified from a
laptop -- it needs you and the phone.

Once it passes: **freeze. No code changes.** Write down anything you find and fix
it after the demo.

## 2. The night before

- [ ] `demo.mp4` exists, plays, and is the right build. **Non-negotiable.**
- [ ] `./demo-preflight.sh` passes from a cold start.
- [ ] `./demo-freeze.sh` passes.
- [ ] Read §6, the five hard questions, out loud, twice. They are the part of the
      demo you are actually being assessed on.
- [ ] Decide who talks and who drives. One voice. Do not pass the laptop around.
- [ ] Charge the phone to 100% **and** plug it in. It will be on camera for an hour.
- [ ] Laptop plugged in, notifications off, Do Not Disturb on, one browser tab.
- [ ] Close Slack, email, calendar. Any of them can steal focus on a projector.

## 3. The hour before

- [ ] Ask the phone's owner to install the APK **now**, on their own phone, with
      their own consent. See §9.3 of `plan.md` -- this is the single biggest
      reduction in risk available and it costs one conversation.
- [ ] They complete enrollment: Accessibility on, screen sharing allowed,
      screen timeout 30 min, battery Unrestricted.
- [ ] Verify from the laptop: the phone appears in the console, live view flows.
- [ ] Run one full rehearsal at your desk, timed. Under 4 minutes.
      `./check-all.sh` is not a rehearsal. This is:
      ```
      cd relay && node tools/rehearse.mjs --url $RELAY_URL --device <device-id>
      ```
      It drives the console through all six beats on a timer and tells you which
      beat ran long. It works against a synthetic phone before the device exists,
      and against the real device with `--device`, and the choreography is
      identical in both -- so the path you practise is the path you perform.
- [ ] Record the fallback video, once, on the real phone:
      ```
      cd relay && node tools/record-demo.mjs --url $RELAY_URL --device <device-id>
      ```
      Output is `demo.mp4`. Play it once, end to end, before you rely on it.
- [ ] **Freeze. No code changes from here.** If something is wrong, it is a
      rehearsal finding for after the demo, not a change to make now.

## 4. The fifteen minutes before

- [ ] `./demo-preflight.sh` -- every automated check green.
- [ ] Work the printed phone checklist at the bottom of the pre-flight output.
- [ ] Phone: unlocked, awake, screen timeout 30 min, on cellular data, **not** on
      the venue wifi, orientation as you will present it.
- [ ] Nothing sensitive on screen. Clear notifications. Close anything private.
      This is someone's actual phone and it will be projected.
- [ ] `./demo-start.sh` -- console opens fullscreen and paired.
- [ ] Confirm the live view is flowing *before* anyone is watching.

## 5. The talk track

Opening move, before any of the beats: **have someone in the room unlock the phone
themselves.** Hand it to them, let them unlock it, take it back. It takes four
seconds and it establishes that this is their phone and their consent, which is the
entire argument of the project. Then:

> "This phone has not been touched since you installed it yourself."

Do not claim it was installed three minutes ago if it was not -- see §7.

| # | Beat | Say | Show |
|---|---|---|---|
| 1 | Enroll | What each of the three permissions is for. Say them out loud, by name. | `enroll.pdf` on screen, 20 seconds max |
| 2 | Live control | "This phone is on 4G. This laptop is on the venue wifi. They have never met." | Type in a search field, open an app, send a message, take a photo |
| 3 | Give it back | "This is your phone. Your consent screen is still running." | Hand it to the room. They tap, swipe, press Home. It all works. |
| 4 | Find and script | "No coordinates." | Type a button's label, watch it tap itself. Then run a three-step script with zero manual input. |
| 5 | Record | "And it's recording." | Hit record. Show the REC indicator and the file landing. |
| 6 | Close | What it is, what it is not, where the real product boundary is. | Enterprise MDM on company-owned, IT-managed devices |

**Say the network thing out loud during beat 2.** Phone on cellular, laptop on venue
wifi. It is the entire point and nobody will infer it.

**Beat 3 is not optional.** Handing the phone back and watching the room use it
does more for credibility than any other 20 seconds in the demo.

Total: about 4 minutes. If you are running long, cut beat 5 and move faster
through beat 2. Do not cut beat 3.

---

## 6. The five hard questions

Rehearse these. They are the real assessment.

**"Is this legal? Can it be used without the user knowing?"**
> No. Consent at install, a permanent visible notification, and uninstall in two
> taps. It is deployable *because* it is transparent. A tool that survives removal
> is a different product, and I will come back to that.

**"Can you read my WhatsApp?"**
> No. There is no UI surface exposed to me to read, and no permission to read one
> with. I see and drive the screen you are already looking at. Reading another
> app's data needs root, and this app has none.

**"Can it work with the screen off?"**
> Not on a non-rooted phone. That needs ADB or root. The screen stays on, visibly,
> and that is a deliberate limit rather than a bug.

**"What stops a user uninstalling it?"**
> Nothing, by design. A device that must resist uninstallation is a different
> product: Android Enterprise device-owner mode, which requires a factory-reset,
> IT-managed device. That is the real answer and it belongs on the closing slide.

**"How is this different from AirDroid or TeamViewer?"**
> Same primitives -- accessibility plus screen capture. Ours is ours, no per-seat
> licence cost, and the code is the artifact.

---

## 7. Two things not to say

**Do not claim the install happened live.** `plan.md` §9.3 recommends asking the
owner to install a few hours beforehand, and §12's opening line says "installed by
you three minutes ago." Those contradict. Go with the pre-install ask -- it is far
lower risk -- and say "you installed this yourself."

**Do not say "works on any Android phone."** With one tested device the honest
wording is:

> "Engineered for Android 8.0 and newer. Validated on \[model\], running Android
> \[version\]."

One data point is a fact. Two vendors is a claim. Do not upgrade the claim to fit
the moment.

---

## 8. If it goes wrong

| Symptom | Do this | Do not |
|---|---|---|
| Nothing works in the first 60s | **`demo.mp4`.** Then the architecture slide. | Restart anything |
| Live view is blank | Say "screen capture consent was cleared -- Android requires one tap after a restart." Re-tap on the phone while talking. It is a normal Android behaviour and demonstrating it honestly is better than hiding it | Quit and relaunch the app |
| Taps do nothing | Check the console's "Gestures work" badge. If red, the Accessibility grant was lost -- re-enable on the phone, live, out loud | Re-grant silently |
| Frame rate collapses | The console has already stepped quality down automatically. Say "it's adapting to the network." That is the feature working | Touch the quality control |
| Venue wifi is blocking WebSockets | The phone's own 4G is the fallback and it is independent of the venue. If the *laptop* cannot reach the relay, switch the laptop to a hotspot | Debug the venue network |
| The phone owner is visibly uncomfortable | Stop. Hand it back. Offer the video | Push on |

### Before the day

The 30-minute stability requirement (definition of done item 4) has to be run
against the real handset, because what breaks in 30 minutes is phone-side: the OEM
battery manager killing a background service, MediaProjection consent being
revoked, the encoder drifting, the socket dropping on a moving network.

```
cd relay && node tools/soak-device.mjs --url $RELAY_URL --device <device-id> --minutes 30
```

Leave the phone on 4G, screen on, untouched. It refuses to count a synthetic
device as a pass, and it tells you to re-run if the screen slept rather than
letting you blame the app for a timeout you can fix in Settings.

The console's fallback ladder, in order:

1. Reconnect the agent. Most "failures" are a dropped socket, not a crash, and the
   console shows the state. This is one click.
2. `demo.mp4`.
3. Stop and talk about the architecture.

---

## 9. Definitions of "done" for the day

- [ ] Live view, tap, swipe, type, find-and-tap, global nav all working over 4G
      with the laptop on a different network
- [ ] 30 minutes of continuous operation, no crash, no dropped session
- [ ] Rehearsal under 4 minutes, twice, on consecutive days
- [ ] `demo.mp4` plays
- [ ] Phone's screen timeout is 30 minutes. **Check this one every time.**
