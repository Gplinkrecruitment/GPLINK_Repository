# iOS App Store Pre-Submission Checklist

Plain-English checklist for getting GP Link onto the Apple App Store. Written for a non-engineer — each section says what needs doing, why, and how to check it's done.

**Where things stand today:** the app is already set up to become an iPhone app (a tool called Capacitor is configured with the app name "GP Link" and the ID `com.mygplink.app`), but the actual iPhone project has **never been generated** — there is no `ios/` folder in the codebase. That means the very first step below is mandatory, and until it's done the app cannot be built for iPhone at all.

---

## 1. Generate the iPhone project (must be done first)

- [ ] On a Mac, install **Xcode** (free, from the Mac App Store) and **CocoaPods** (a helper tool Xcode projects use — a developer runs `sudo gem install cocoapods` once).
- [ ] In the project folder, run: `npx cap add ios`
      This creates the `ios/` folder — the actual iPhone app project. It only needs to be done once, then the folder is kept in the code repository.
- [ ] After any web-code changes, run `npx cap sync ios` so the iPhone app picks them up.
- [ ] Open the project in Xcode (`npx cap open ios`) and confirm it builds and runs in the iPhone Simulator.

## 2. Permission wording (skip this and Apple auto-rejects)

The app uses the phone's **camera** to scan documents (the qualification/ID scanner). Apple requires a plain-English sentence explaining every permission, stored in a file called `Info.plist` inside the new `ios/` folder. If the camera text is missing, the app **crashes the moment the camera opens** and Apple rejects the submission.

Add these entries to `ios/App/App/Info.plist`:

- [ ] **NSCameraUsageDescription** — suggested wording:
      *"GP Link uses your camera to scan your qualification and identity documents."*
- [ ] **NSPhotoLibraryUsageDescription** (needed if users can pick an existing photo of a document instead of scanning) — suggested wording:
      *"GP Link needs access to your photo library so you can choose photos of your documents to upload."*

## 3. Push notifications setup

The app already has the code to register for push notifications (`js/native-bridge.js` sends the device's push token to our server). The iPhone project still needs Apple's side switched on:

- [ ] In Xcode, add the **Push Notifications** capability to the app target.
- [ ] Confirm the entitlements file gets the **aps-environment** entry (Xcode adds this automatically when the capability is enabled; it should say `production` in the App Store build).
- [ ] In your Apple Developer account, make sure the App ID `com.mygplink.app` has Push Notifications enabled and an APNs key/certificate is set up so the server can actually send pushes.

## 4. Things the app already has (verify, don't rebuild)

These are Apple requirements the app already meets — just double-check each one still works before submitting:

- [ ] **Account deletion inside the app** — the Account page (`pages/account.html`) has a "Delete account" button. Apple requires this for any app with sign-in.
- [ ] **Privacy policy** — exists at `pages/privacy.html`. You'll paste its public URL into App Store Connect.
- [ ] **Terms of service** — exists at `pages/terms.html`.
- [ ] **Sign in with Apple** — the sign-in page (`pages/signin.html`) has "Continue with Apple" buttons. Apple requires this because the app also offers Google sign-in. Confirm the Apple button actually completes a sign-in on a real device.

## 5. App Store Connect (Apple's submission website)

- [ ] Create the app record in App Store Connect using the ID `com.mygplink.app` and the name "GP Link".
- [ ] Write the **metadata**: app description, keywords, support URL, and the privacy policy URL.
- [ ] Fill in the **App Privacy** questionnaire (what data the app collects — e.g. name, email, documents, and why).
- [ ] Prepare **screenshots** for the required iPhone sizes (take them in the Simulator or on a device).
- [ ] Write **review notes** for Apple's tester, including a **working demo login** (email + a way past the one-time-code login, e.g. a dedicated test account whose code the reviewer can use). Apple will reject the app if their reviewer can't get past the sign-in screen.

## 6. Environment safety check

- [ ] Confirm the production server does **not** have `AUTH_DISABLED=true` set. That setting turns off login checks entirely — it exists for local development only and must never be on in production, especially not in a build Apple reviews.

## 7. TestFlight smoke test (before submitting for review)

Upload a build to TestFlight and personally check each of these on a real iPhone:

- [ ] **Camera document scan** — open the qualification scanner, grant the camera permission when asked, and scan a document end-to-end.
- [ ] **Push notifications** — the permission prompt appears, and a real notification arrives on the phone (e.g. trigger one from the admin dashboard).
- [ ] **Deep links** — tapping a GP Link email link (e.g. an "Open Document" link) opens the right screen inside the app.
- [ ] **Sign in with Apple** — complete a full sign-in with an Apple ID.
- [ ] **Account deletion** — create a throwaway test account, delete it from the Account page, and confirm you're signed out and the account is gone.

Once every box above is ticked, submit for review in App Store Connect.
