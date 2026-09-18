import type { HTMLAttributes } from 'react';

/**
 * The Cartenz mark (Cartensz Pyramid / Puncak Jaya — the highest ground in
 * Indonesia, and where the name comes from), sized to sit inline with text.
 *
 * Rendered from the static asset rather than inlined, so there is exactly one
 * copy of the geometry: infrastructure/brand/generate.py writes
 * frontend/public/brand/mark.svg, and every place that shows the mark —
 * favicon, manifest, this component — reads from that one file.
 */
export function CartenzMark({
  size = 24,
  className,
  ...rest
}: { size?: number } & HTMLAttributes<HTMLImageElement>) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a static brand
    // asset with a fixed intrinsic size; next/image adds nothing here.
    <img
      src="/brand/mark.svg"
      alt="Cartenz"
      width={size}
      height={size}
      className={className}
      {...rest}
    />
  );
}
