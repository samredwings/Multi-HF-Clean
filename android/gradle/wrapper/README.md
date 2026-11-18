# Gradle Wrapper binary

This project pins the wrapper distribution to Gradle 8.9 in `gradle-wrapper.properties`.

The text source bundle includes `gradlew`, `gradlew.bat`, and the properties file. The binary `gradle-wrapper.jar` is not embedded in this bundle. Restore it using one of these options:

**Preferred (requires Gradle 8.9 installed):** from the `android/` directory, run:

```sh
gradle wrapper --gradle-version 8.9 --distribution-type bin
```

**Direct restore:** download the official Gradle 8.9 wrapper JAR into this directory:

```sh
curl -fL https://raw.githubusercontent.com/gradle/gradle/v8.9.0/gradle/wrapper/gradle-wrapper.jar -o gradle-wrapper.jar
```

On Windows PowerShell:

```powershell
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/gradle/gradle/v8.9.0/gradle/wrapper/gradle-wrapper.jar" -OutFile "gradle-wrapper.jar"
```

Verify the downloaded file's SHA-256 against Gradle's published Gradle 8.9 wrapper checksum before executing it:

`498495120a03b9a6ab5d155f5de3c8f0d986a449153702fb80fc80e134484f17`

Then run `./gradlew --version` (or `gradlew.bat --version`) from `android/`.
