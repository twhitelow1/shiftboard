---
name: app-store-registration
description: Walks Todd (DubLow Digital) step by step through registering the developer accounts and app records for DubLow's restaurant staff app (ShiftBoard is the working name) on the Apple App Store, Google Play and Expo/EAS, by reading the registration runbook in the shiftboard repo (docs/mobile-app/REGISTRATION-RUNBOOK.md, RECORD.md, STORE-LISTING.md, DECISION.md) and picking up where the last session stopped. Use it whenever Todd asks to register or set up the mobile app, the Apple Developer Program, App Store Connect, TestFlight, the Google Play Console, a D-U-N-S number, the Expo or EAS account, push credentials (APNs, FCM, Firebase), or the first store build and submission, or says things like "let's do the app store stuff", "where are we on the developer accounts" or "continue the registration", even if he doesn't name the runbook.
---

# App store registration (DubLow restaurant app)

The repo holds a tested, step-by-step runbook for getting DubLow's restaurant staff app (Expo / React Native, working name ShiftBoard) into the Apple App Store and Google Play. This skill makes you its guide: read the runbook, work out what's already done, and take Todd through the next steps one at a time, stopping wherever a human has to act.

The runbook was researched against the stores' sites and has deliberate stop points. Follow it rather than memory: store flows, fees and rules change often, and Todd relies on it being right.

## 1. Load the docs

All four live in the `twhitelow1/shiftboard` repo under `docs/mobile-app/`:

| File | What it's for |
|---|---|
| `REGISTRATION-RUNBOOK.md` | The steps, in order, with hard rules, the 🛑 STOP points and the "Values to use" table. **Read it all first.** |
| `RECORD.md` | Progress: non-secret IDs, status, and a dated log. Tells you where to resume. |
| `STORE-LISTING.md` | Text and answers for the store forms (descriptions in English and Spanish, privacy and data-safety answers, review notes). |
| `DECISION.md` | Why Expo and one app for every restaurant, plus the **name risk** that has to be settled before the app records exist. |

Get them in this order of preference:
1. **A local checkout** (Claude Code in the repo): read the files directly. Pull first (`git fetch` / `git pull` on the working branch) so you're on the latest record.
2. **A GitHub tool or connector**: fetch each file from `twhitelow1/shiftboard`, default branch.
3. **Neither**: ask Todd to paste or attach the runbook and RECORD.md. Don't reconstruct the steps from memory.

## 2. Work out where things stand

Before starting any step:
- Read RECORD.md's **Identifiers and status** table and the last few **Log** entries, and find the first runbook section that isn't done.
- Say it back to Todd in one or two lines and confirm. For example: "Last time we requested the D-U-N-S number (Nov 22). Has Dun & Bradstreet emailed you the number yet?" Things may have moved on outside the session: Apple approvals, D&B emails.
- **Check the blockers the runbook calls out:**
  - the legal entity (Apple won't enroll a sole proprietorship as an organization)
  - the D-U-N-S number
  - a live DubLow website and a DubLow-domain email
  - **the final store name** (needed before the app records in sections 3.3 and 5)
  
  If one is missing, help with that first. For example, D-U-N-S has the longest wait, so it goes first.
- **Running in parallel is fine:** the Expo account (section 6) doesn't depend on Apple or Google. Waiting days on Apple verification is a good time to do Google or Expo.

## 3. Guide one step at a time

For each step:
1. **What, where, why:** say what you're doing, the exact URL, and why, in plain words.
2. **Non-secret values:** give the exact values to enter, from **Values to use** or STORE-LISTING.md, ready to copy. If a value is still a placeholder like **[DubLow's exact legal name]**, ask Todd for it once and then write it into RECORD.md.
3. **Success:** say what success looks like, from the runbook's success sign, so you both know when to move on.
4. **Wait:** wait for Todd to say it's done, or what he sees, before the next step.

**At a 🛑 STOP:** tell Todd exactly what he has to do, why it has to be him, and how you'll know it's done. Then wait.
- **His alone:** paying, accepting agreements, passwords and 2FA codes, ID and organization verification, and anything that publishes.
- **Never do these yourself:** typing secrets, ticking legal checkboxes or clicking pay, accept or publish, even if he asks you to "just do it". These bind DubLow legally and financially, and the stores hold the account holder responsible.

**If you can drive a browser** (e.g. Claude in Chrome): do the clicking and typing for non-secret fields yourself, and hand control back at every STOP. Read the page before acting. If it doesn't match the runbook (a renamed button, a new required field, an unexpected fee or warning), stop, describe what you see, and ask. Never improvise around a legal, payment or verification screen.

**If you're only chatting:** give Todd the steps to do himself, one at a time, and have him tell you what he sees.

## 4. Keep the record up to date

At every STOP and at the end of each section, add a dated line to RECORD.md's **Log** (what was done, by whom, what's next). Fill in any **non-secret** identifiers you learned: Team ID, enrollment ID, app IDs, account IDs, key *IDs* (never key files).

- **Secrets never go in RECORD.md, the repo or chat:** passwords, 2FA or recovery codes, card or bank numbers, tax IDs, API keys, `.p8` / `.p12` / keystore / service-account `.json` files. RECORD.md lists where those belong: EAS credentials, Vercel environment variables, or DubLow's password manager.
- **How to save the record:**
  - **Local checkout:** edit `docs/mobile-app/RECORD.md`, commit with a clear message, and push following the repo's branch and PR rules.
  - **A GitHub tool with write access:** propose the change as a PR.
  - **Otherwise:** give Todd the exact lines to paste, so the next session can pick up.

## 5. Wrap up each session

End with a short summary:
- what's done
- the IDs recorded
- what you're waiting on and roughly how long (D&B up to 5 business days plus 2 for Apple to see it; Apple and Google verification can take days)
- the single next step

When everything through runbook section 8 is done, point Todd to section 9 ("Going public"), which is his call, not the agent's.
