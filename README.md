# Outline Studio — client-only pipeline

A static HTML/CSS/JavaScript outline editor. No backend, CDN, analytics, or upload endpoint is used. Images are decoded and processed in the user's browser; exports are created as local downloads.

## Run

- Open `index.html` directly in a modern Chromium/Firefox browser, or serve this folder as static files.
- Choose a transparent PNG/WEBP and select **파이프라인 실행**.
- Use the brush to add material or the eraser to remove it from the final cut mask. Brush size is measured in mm.
- `Ctrl/Cmd+Z` undoes a stroke; **자동 결과로 되돌리기** discards manual edits.
- Export the final cutline as SVG (embedded source image + vector cutline), PNG preview, or metrics JSON.

## Implemented client pipeline

1. Crop alpha > 1, threshold foreground at alpha > 8, remove components below 1 mm² and fill enclosed holes.
2. Apply the configured outward contour offset (default 2 mm).
3. Search for narrow necks by eroding by half the configured web width (default 5 mm radius); where two substantial cores are close and the connecting segment lies inside the silhouette, add a rounded web of the configured width (default 10 mm).
4. Create a 50 mm-wide, full-outline-height rounded scaffold, classify rectangle-only components, and drop any that intersects the upper-third band.
5. Apply local closing for the configured gap-fill limit (default 4 mm) and local junction blend.
6. Add the directly attached center tab (30 × 3 mm, 1 mm taper per side, R0.75 mm end) and validate dimensions/topology.
7. Provide brush/eraser editing directly on the final binary cut mask, with undo/reset and live component/hole/size checks.

The default overall cut height is 148.5 mm including the center tab; input artwork is scaled to accommodate the configured offset and tab depth. Print/output dimensions are exported in physical millimetres. Manual edits may change the dimensions and connected-component checks; review the live metrics after editing.

## Notes

- This is an in-memory client-only implementation; closing the page clears the session unless files have been exported.
- The browser UI is an editing and geometry-checking tool, not a material strength certification.
- The Python batch outputs and earlier reference/test bundles live outside this clean source folder and are not deleted or overwritten by this app build.
