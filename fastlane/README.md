fastlane documentation
----

# Installation

Make sure you have the latest version of the Xcode command line tools installed:

```sh
xcode-select --install
```

For _fastlane_ installation instructions, see [Installing _fastlane_](https://docs.fastlane.tools/#installing-fastlane)

# Available Actions

## iOS

### ios beta

```sh
[bundle exec] fastlane ios beta
```

Archive Mongjin and upload it to TestFlight

### ios metadata

```sh
[bundle exec] fastlane ios metadata
```

Upload localized App Store listing metadata without a binary or review submission

### ios production

```sh
[bundle exec] fastlane ios production
```

Submit the uploaded build for App Store review

----


## Android

### android metadata

```sh
[bundle exec] fastlane android metadata
```

Upload localized Google Play listing metadata without an app bundle

### android internal

```sh
[bundle exec] fastlane android internal
```

Upload the signed Mongjin bundle to Google Play internal testing

### android alpha

```sh
[bundle exec] fastlane android alpha
```

Upload the signed Mongjin bundle to Google Play closed testing (비공개 테스트)

----

This README.md is auto-generated and will be re-generated every time [_fastlane_](https://fastlane.tools) is run.

More information about _fastlane_ can be found on [fastlane.tools](https://fastlane.tools).

The documentation of _fastlane_ can be found on [docs.fastlane.tools](https://docs.fastlane.tools).
