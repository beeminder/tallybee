https://tallybee.beeminder.com

## Wishlist

1. What we really need is a way to have an icon on your phone's homescreen that opens up TallyBee with a specific Beeminder goal selected.


## Open questions

1. Should TallyBee remember a separate count per goal?

2. Probably kill the "via TallyBee [timestamp]" as the default comment. It's an anti-magic violation and a deviation from the behavior of the Beeminder dashboard. On the other hand it's valuable for confirming datapoint submissions. Probably the right answer is that we should just make metadata like submission time easier to see.

3. Do we follow the Beeminder dashboard precendent of labeling the submit button "add progress"? I kind of like just "Submit".

4. Does there need to be a logout button? In principle yes, I guess? Maybe you want to let a friend do pushups with your phone. But it would be nice to minimize its footprint. Could we put seldom-used things like that in the help popup?

5. Maybe the static safesum text could be shown subtly at the very top of the screen. Maybe username/goalname there too. Save the footer control area for interactive elements. Also the current daily rate (plus upcoming daily rate, if different?) is something a user often wants visible.

6. What should happen when you load an odometer goal? Currently the app violates the seeming invariant that the big blue tally always mirrors the datapoint value field: the tally shows the delta and the field shows the absolute number.

7. How to handle it when the Beeminder deadline passes and it becomes a new day. Probably emulate the Beeminder dashboard: throw up a warning banner but don't tamper with the UI.


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
