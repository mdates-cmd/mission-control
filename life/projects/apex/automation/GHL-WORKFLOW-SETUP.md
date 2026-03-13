# GHL Post-Purchase Workflow Setup Guide
## Deal Flow AI Playbook — Automation

Neo built all the email copy. You just need to wire it up in GHL.
Estimated time: 20-30 minutes.

---

## Prerequisites
- [ ] PDFs hosted and download links ready (see PDF URLs below once pushed to GitHub Pages)
- [ ] Community URL (add when ready — can use placeholder for now)
- [ ] GHL Automation section accessible

**PDF URLs (once GitHub Pages updates):**
- Playbook PDF: `https://mdates-cmd.github.io/mission-control/preview/deal-flow-ai-playbook.pdf`
- Prompt Swipe File: `https://mdates-cmd.github.io/mission-control/preview/lead-magnet-b-prompts.pdf`

---

## Step 1 — Create the Workflow

1. In GHL, go to **Automation → Workflows → + New Workflow**
2. Choose **Start from Scratch**
3. Name it: `Post-Purchase: Deal Flow AI Playbook`
4. Set status to **Active** when ready to go live (leave Draft while building)

---

## Step 2 — Set the Trigger

1. Click **Add Trigger**
2. Select: **Order Form Submission** (or "Product Purchased" if available)
3. Filter by product: **The Deal Flow AI Playbook** (`69b1bfb5711f98315d61a492`)
4. Save trigger

---

## Step 3 — Action 1: Add Tag

1. Click **+** to add action
2. Select: **Add Contact Tag**
3. Tag: `playbook-buyer`
4. Save

---

## Step 4 — Action 2: Send Email #1 (Instant Delivery)

1. Click **+** to add action
2. Select: **Send Email**
3. Fill in:
   - **From Name:** Deal Flow AI
   - **From Email:** hello@dealflowaiconsulting.com
   - **Subject:** Your Deal Flow AI Playbook is ready
   - **Body:** (paste from POST-PURCHASE-EMAILS.md Email 1, replace placeholders)
     - `{{PLAYBOOK_PDF_URL}}` → `https://mdates-cmd.github.io/mission-control/preview/deal-flow-ai-playbook.pdf`
     - `{{PROMPT_FILE_URL}}` → `https://mdates-cmd.github.io/mission-control/preview/lead-magnet-b-prompts.pdf`
4. Save

> **Note on Prompt Swipe File:** Ideally add an IF/ELSE condition — if tag "prompt-swipe-buyer" exists, include the swipe file link. Otherwise omit that line. Or just include both links with labels — buyers who didn't purchase will just see a link to something they didn't buy (not ideal, but simpler).

---

## Step 5 — Action 3: Wait 2 Days

1. Click **+** → **Wait**
2. Set: 2 days
3. Save

---

## Step 6 — Action 4: Send Email #2 (Day 2 Check-In)

1. Click **+** → **Send Email**
2. From: hello@dealflowaiconsulting.com | From Name: Deal Flow AI
3. Subject: Quick check-in: have you used the playbook yet?
4. Body: (paste from POST-PURCHASE-EMAILS.md Email 2)
   - Replace `{{COMMUNITY_URL}}` with your community link when ready
   - Placeholder OK for now: `https://dealflowaiconsulting.com/community`
5. Save

---

## Step 7 — Action 5: Wait 3 More Days

1. Click **+** → **Wait**
2. Set: 3 days
3. Save

---

## Step 8 — Action 6: Send Email #3 (Day 5 Upgrade)

1. Click **+** → **Send Email**
2. From: hello@dealflowaiconsulting.com | From Name: Deal Flow AI
3. Subject: Ready to go deeper? Get the full Deal Flow AI course
4. Body: (paste from POST-PURCHASE-EMAILS.md Email 3 — no placeholders, link is hardcoded)
5. Save

---

## Step 9 — Publish

1. Click **Save** in top right
2. Toggle workflow status to **Active**
3. Test by purchasing a $0 test product or using GHL's test contact feature

---

## Order Bump Handling (Prompt Swipe File)

If you want separate delivery for order bump buyers:
1. Create a **second workflow** named `Post-Purchase: Prompt Swipe File`
2. Trigger: Product Purchased → "AI Prompt Swipe File" (`69b1bfeea8560724250d7154`)
3. Action: Add Tag `prompt-swipe-buyer`
4. Action: Send Email with just the swipe file download link

This way Email 1 in the main workflow can be simplified to only deliver the playbook, and the swipe file gets its own clean delivery email.

---

## Pipeline Stage (Optional but Recommended)

After setting up the workflow:
1. Go to **CRM → Pipelines → + New Pipeline**
2. Name: `Deal Flow AI Sales Pipeline`
3. Stages: Lead → Prospect → Playbook Buyer → Course Student → DFY Client
4. In the workflow above, add action: **Create/Update Opportunity** → set to "Playbook Buyer" stage

This gives you a visual dashboard of your customer journey.
