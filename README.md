https://tallybee.beeminder.com

Staging for Claude:
it turns out i don't want wade through all the junk in the non-human section of AGENTS.md. can you go through all that and ask me what you still need to one thing at a time?

## Wishlist

1. What we really need is a way to have an icon on your phone's homescreen that opens up TallyBee with a specific Beeminder goal selected. And most important that that work on iPhone since the impetus for TallyBee is to replicate the functionality built into Beedroid, the Beeminder Android app.

2. The footer got so cluttered. We could move more things to the help popup for starters? Or maybe we want a hamburger menu where everything that shouldn't clutter the footer should go, including the help button?

3. Bug: The app is currently scrolling for me when installed as an app (PWA, however that works) on Android.


## Open questions

1. Should TallyBee remember a separate count per goal?

2. Probably kill the "via TallyBee [timestamp]" as the default comment. It's an anti-magic violation and a deviation from the behavior of the Beeminder dashboard. On the other hand it's valuable for confirming datapoint submissions. Probably the right answer is that we should just make metadata like submission time easier to see.

3. Do we follow the Beeminder dashboard precendent of labeling the submit button "add progress"? I kind of like just "Submit".

4. Does there need to be a logout button? In principle yes, I guess? Maybe you want to let a friend do pushups with your phone. But it would be nice to minimize its footprint. Could we put seldom-used things like that in the help popup?

5. Maybe the static safesum text could be shown subtly at the very top of the screen. Maybe username/goalname there too. Save the footer control area for interactive elements. Also the current daily rate (plus upcoming daily rate, if different?) is something a user often wants visible.

6. What should happen when you load an odometer goal? Currently the app violates the seeming invariant that the big blue tally always mirrors the datapoint value field: the tally shows the delta and the field shows the absolute number.

7. How to handle it when the Beeminder deadline passes and it becomes a new day. Probably emulate the Beeminder dashboard: throw up a warning banner but don't tamper with the UI.

8. The scroll-bug fix (v2026.10.08a) makes the page as tall as its window (CSS height: 100%) rather than 100dvh (the "dynamic viewport height"), since Chrome on Android can work out 100dvh as taller than an installed app's window (Chromium issues 463721080 and 453570183). The cost is in a browser tab: whenever Chrome's address bar slides away, as it can after you pinch-zoom and drag, a black strip as tall as the address bar shows below the footer till the bar comes back, and it's unknown whether Chrome brings it back on a page with nothing to scroll. (With 100dvh the page grew to fill that space instead, but could then be scrolled by that much.) The alternative is pinning the page to the screen (position: fixed), which fills the screen with or without the address bar, at the cost of four more lines of CSS, a reworded pull-to-refresh qual, and one untested case: what Safari on iPhones does with a pinned page when the keyboard comes up. Keep the strip, or pin the page?


## Closed questions and completed things

In case we want to turn these into a spec:

* Even when offline / not logged in it might as well let you edit the number and datapoint comment. Just don't let you try to submit it, of course.

* Infinite undo, why not.

* Fathful emulation of the Beeminder dashboard UI for data entry. Main thing we *don't* want to from Beeminder's UI is the stepper buttons on the datapoint value, since that's redundant for TallyBee.

* Need to see what date we're submitting for (see above).

* Include the parenthetical sigma on the submit button for kyoom goals.

* Probably include the previous datapoint, like the Beeminder dashboard does.

* Link to the goal page on Beeminder.

* The placeholder text for the datapoint comment should be the previous datapoint's comment, as on the Beeminder dashboard.

* Anti-magic says don't prevent submission when the datapoint is zero. Death to if-statements.

* I think pull-to-refresh should still work? Currently trying to do that just registers as another tally +1.

* The big blue number should update in real time as you edit the datapoint value field. This ensures the user understands the datapoint value field and the big blue tally necessarily mirror each other. And you can always hit Undo if you didn't want to lose the tally. (Except currently Undo fails at that if you tap the tally after editing the datapoint value, since there's only 1 level of undo. Another reason to have infinite undo.)

* Link explicitly to the github repo and sourcery.html at the bottom of the help popup. Anchor text can be "Source / Sourcery" with "Source" linking to the repo and "Sourcery" linking to sourcery.html.
