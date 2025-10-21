# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2025-01-21

Complete rewrite in TypeScript with modern JavaScript features.

### Breaking Changes
- **No backward compatibility with v1.0**
- ES modules only (CommonJS also supported via build)
- Named exports: `import { Encoder, Decoder } from 'polynar'`
- No global `Polynar` object
- No UMD build

### Added
- Full TypeScript support with comprehensive type definitions
- Dual module system (CommonJS and ESM)
- Modular architecture with separate files for each encoding type
- Explicit module registration system
- Custom module support via `registerModule` API
- Comprehensive test suite with 85.6% coverage
- Modern build system with multiple output formats
- Examples directory with usage demonstrations
- CI/CD pipeline with GitHub Actions

### Changed
- Refactored from single 1000+ line file to modular structure
- Module registration now explicit instead of side-effect based
- Updated to modern JavaScript (ES2020+)
- Improved type safety throughout

### Fixed
- Date encoding bug where interval was applied twice during decode
- Character set validation edge cases
- Various type safety issues

## [1.0.0] - 2014

Initial release with:
- Number, string, boolean, date, object, fraction, item, and any type encoding
- Multiple character set support
- Strict and non-strict modes
- Pre/post processing hooks
- Template-based object encoding
