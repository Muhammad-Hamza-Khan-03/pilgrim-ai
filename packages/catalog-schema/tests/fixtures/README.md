# Catalog schema fixtures

The generator tests compile the repository's `packs/umrah-stays/pack.yaml` and
`packs/car-rental/pack.yaml` with `@pilgrim/engine` before passing the resulting
`Pack` objects to the generator. The generator itself never parses YAML.
