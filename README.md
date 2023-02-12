TODO:

1. In Replit's preview pain we currently see "www.beeminder.com refused to connect". Which I guess is CORS crap. Let's figure out how to work around that, since it's so nice having that preview pane in Replit.

2. Handle a 401 error, which happens if you log in to TallyBee on multiple devices.

3. Make the UI in the bottom strip non-hideous.

4. Reset to zero when you hit submit, but only if submission actually succeeds. Relatedly, it needs to be super clear when/if the submission succeeds. Show a spinner until the Beeminder server responds?

5. The "bottom modal" when you click the "background" button doesn't work on mobile -- there's no way to dismiss it if the screen is too small for the X (close button) to be visible.

6. Show amount of safety buffer or the delta to dispatch the beemergency (for the selected Beeminder goal).
