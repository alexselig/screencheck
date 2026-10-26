// Capture every screen of a shop at three widths and register the result:
//
//   npx screencheck capture --config examples/screencheck.config.mjs --version build-43
//   npx screencheck capture --config examples/screencheck.config.mjs --screen checkout
//
// Each width becomes its own version (build-43-390, build-43-768,
// build-43-1440) in revision build-43, captured into
// ./captures/build-43/<width>/<screen>.png with an element map beside each.

export default {
  project: { id: "shop", name: "Shop" },
  baseUrl: "http://localhost:3000",
  // The revision; --version on the command line wins.
  version: "build-43",
  viewports: [390, 768, 1440],
  screens: [
    { id: "home", title: "Home", url: "/" },
    {
      id: "product",
      title: "Product",
      url: "/products/kettle",
      caption: "In stock, two colours",
      section: "Browse",
      waitFor: "img.hero",
    },
    {
      id: "checkout",
      title: "Checkout",
      url: "/cart",
      caption: "Step 2 of 3, saved card",
      section: "Buy",
      // Declarative steps also work in a .json config.
      steps: [
        { click: "text=Check out" },
        { fill: "#email", value: "sam@example.com" },
        { click: "text=Continue" },
        { waitFor: ".payment" },
      ],
    },
    {
      id: "order-history",
      title: "Order history",
      url: "/login",
      section: "Account",
      // A .mjs config can run any Playwright code instead.
      setup: async (page, { viewport }) => {
        await page.fill("#user", "sam");
        await page.fill("#password", "demo");
        await page.click("button[type=submit]");
        await page.goto("http://localhost:3000/orders");
        if (viewport < 768) await page.click("[aria-label='Open menu']");
      },
    },
  ],
};
