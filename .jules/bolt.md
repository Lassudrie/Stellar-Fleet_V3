## 2025-05-23 - Spatial Index Quadratic Scan
**Learning:** `SpatialIndex.findNearest` was re-scanning all inner cells for every increment of search radius, leading to O(R^4) complexity (where R is search radius) for searching the whole map.
**Action:** When implementing expanding ring searches on a grid, ensure you only visit the *perimeter* (ring) of the expanded area, not the full area again.