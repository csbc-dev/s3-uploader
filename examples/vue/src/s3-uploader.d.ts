// Augment Vue's GlobalComponents so the template type-checker accepts
// <s3-uploader>. Vue's runtime treats it as a native element thanks to the
// `isCustomElement` rule in vite.config.ts.
//
// Asymmetry with the React example (s3-uploader.d.ts there types every
// attribute — bucket / prefix / content-type / multipart-threshold / …) is
// intentional, not an omission. React's JSX `IntrinsicElements` is the only
// place to declare a custom element AND its attribute props together, so the
// attributes have to live there. Vue instead recognises the tag via the
// `isCustomElement` compiler rule and does NOT type-check kebab-case custom
// attributes against this interface, so mapping the element type alone is
// sufficient for vue-tsc; listing attributes here would not be enforced.

import type { WcsS3 } from "@csbc-dev/s3-uploader";

declare module "@vue/runtime-core" {
  interface GlobalComponents {
    "s3-uploader": WcsS3;
  }
}
