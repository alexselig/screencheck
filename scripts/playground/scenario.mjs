// The Tidewater scenario shared by the playground (npm run playground) and the
// bundled demo (screencheck demo; its assets are built by
// scripts/demo/build-assets.mjs). Each comment is staged for a step in
// docs/PLAYGROUND.md.
import { SCREENS } from "../site/demo-app.mjs";

// build-42 carries the fixes the agent claims to have made; build-41 is the
// build before them, so switching versions shows a real difference.
export const FIXES = [
  [
    "route",
    '<span class="btn" role="button">Return</span>',
    '<span class="btn" role="button">Return <span class="pill" style="margin-left:6px">Save 10%</span></span>',
  ],
  [
    "sailing",
    "Prices are per vehicle with up to 2 adults.",
    "Prices are per vehicle with up to 2 adults. <b>Per vehicle, 2 adults</b>",
  ],
  ["review-pay", ">Pay £125<", ">Pay £125 for 2 sailings<"],
];

export const VERSIONS = {
  "build-41": SCREENS,
  "build-42": SCREENS.map((screen) => {
    let html = screen.html;
    for (const [id, from, to] of FIXES) {
      if (id === screen.id) html = html.replace(from, to);
    }
    return { ...screen, html };
  }),
};

// Each scenario is staged for a step in docs/PLAYGROUND.md.
export const SEED = {
  "build-41": [
    {
      screen: "route",
      x: 0.62,
      y: 0.53,
      note: "Return toggle is easy to miss; the 10% saving should sit next to it.",
      tags: ["P1", "Conversion"],
      status: "OPEN",
    },
    {
      screen: "sailing",
      x: 0.84,
      y: 0.27,
      note: "Price per what? Say per vehicle in the column header.",
      tags: ["P2", "Copy"],
      status: "OPEN",
    },
  ],
  "build-42": [
    // A fix with a thread, waiting for you to Verify.
    {
      screen: "route",
      x: 0.275,
      y: 0.517,
      note: "Return toggle is easy to miss; the 10% saving should sit next to it.",
      tags: ["P1", "Conversion"],
      status: "RESOLVED",
      reply:
        "Moved the saving into the Return button label and made Return the default.",
      thread: [
        {
          role: "reviewer",
          note: "Better. The saving still reads as body text; give it the teal accent.",
        },
        {
          role: "agent",
          note: "Saving is now a teal tag inside the Return button.",
        },
      ],
    },
    {
      screen: "route",
      x: 0.62,
      y: 0.125,
      note: "Step labels truncate at 1280px.",
      tags: ["P2", "Layout"],
      status: "OPEN",
    },
    // A fix you can Reopen.
    {
      screen: "review-pay",
      x: 0.8,
      y: 0.3,
      note: 'Pay button should say what you pay for: "Pay £125 for 2 sailings".',
      tags: ["P1", "Copy"],
      status: "RESOLVED",
      reply:
        "Label updated; the amount and sailing count both come from the basket.",
    },
    {
      screen: "review-pay",
      x: 0.78,
      y: 0.19,
      note: "Waitlist notice is the most important thing here; give it the top of the page.",
      tags: ["P0"],
      status: "OPEN",
    },
    // Already verified, for comparison.
    {
      screen: "sailing",
      x: 0.84,
      y: 0.27,
      note: "Price per what? Say per vehicle in the column header.",
      tags: ["P2", "Copy"],
      status: "RESOLVED",
      reply: 'Header now reads "Per vehicle, 2 adults".',
      verified: true,
    },
    {
      screen: "sailing",
      x: 0.42,
      y: 0.43,
      note: "Selected sailing needs more than a border. Add a check and repeat it in the footer button.",
      tags: ["P0", "Accessibility"],
      status: "OPEN",
    },
    {
      screen: "sailing",
      x: 0.78,
      y: 0.56,
      note: '"Few seats left" should be its own badge, not tucked in the boat name.',
      tags: ["P1"],
      status: "OPEN",
    },
    // Won't fix, with the agent's reason.
    {
      screen: "home",
      x: 0.78,
      y: 0.72,
      note: "Quick book duplicates the Book tab. Drop it or prefill from the last trip.",
      tags: ["P2"],
      status: "WONT_FIX",
      reply:
        "Keeping it: most repeat bookings start here. Prefilling from the last trip instead.",
    },
    {
      screen: "home",
      x: 0.56,
      y: 0.2,
      note: "Greeting is nice but the next trip is the real headline. Lead with the 08:40 sailing.",
      tags: ["P1", "Hierarchy"],
      status: "IN_PROGRESS",
    },
    {
      screen: "vehicle",
      x: 0.28,
      y: 0.4,
      note: "Manual path asks for length before we explain why. Lead with a car/van picker that fills it in.",
      tags: ["P0", "Flow"],
      status: "IN_PROGRESS",
    },
    // Open items for the agent CLI and MCP to answer.
    {
      screen: "trips",
      x: 0.75,
      y: 0.36,
      note: "Show ticket should be the primary button on the next trip.",
      tags: ["P1"],
      status: "OPEN",
    },
    {
      screen: "confirmation",
      x: 0.5,
      y: 0.3,
      note: "Add the check-in time here too.",
      tags: ["P2"],
      status: "OPEN",
    },
  ],
};

// Settings stays blank and unapproved so you can pin and approve it yourself.
export const APPROVED = { "build-42": ["sign-in"] };
