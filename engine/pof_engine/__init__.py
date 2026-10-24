"""ProofOfForest verification engine (Sentinel-2 NDVI difference-in-differences)."""
from .verify import METHOD_ID, Params, geometry_hash, verify

__all__ = ["METHOD_ID", "Params", "geometry_hash", "verify"]
