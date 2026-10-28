"""Logic without UI. Each module mirrors one in web/src/core/ and passes the same shared cases.

Models, mappings and transformations are plain dictionaries with the same keys as the JSON the web
version reads and writes (docs/internal-model.md): a missing key is `undefined` there, None is `null`.
"""
