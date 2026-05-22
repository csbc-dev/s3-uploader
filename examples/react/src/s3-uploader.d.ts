// JSX intrinsic-element augmentation for <s3-uploader>. Without this,
// TypeScript flags the custom element as unknown.
//
// React 19 (@types/react@19) moved the JSX namespace under `React.JSX` and
// deprecated augmenting the *global* `namespace JSX`. With the automatic
// `react-jsx` runtime the type-checker resolves intrinsic elements from the
// `react` module's JSX namespace, so we augment that instead of `global`.

import type { DetailedHTMLProps, HTMLAttributes } from "react";
import type { WcsS3 } from "@csbc-dev/s3-uploader";

type S3UploaderAttrs = DetailedHTMLProps<HTMLAttributes<WcsS3>, WcsS3> & {
  // In remote mode the server owns `bucket` (and pins it), so it is normally
  // left unset on the client — kept here so the type stays general.
  bucket?: string;
  prefix?: string;
  "content-type"?: string;
  "multipart-threshold"?: string | number;
  "multipart-concurrency"?: string | number;
  "put-retries"?: string | number;
  // NOTE: `key` is intentionally omitted — it collides with React's reserved
  // `key` prop. Set the object key imperatively (`el.key = "…"`) instead; the
  // upload otherwise derives it from the file name.
};

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "s3-uploader": S3UploaderAttrs;
    }
  }
}
