https://tallybee.beeminder.com

## Wishlist

1. What we really need is a way to have an icon on your phone's homescreen that opens up TallyBee with a specific Beeminder goal selected.

2. Even when offline / not logged in it might as well let you edit the number and datapoint comment. Just don't let you try to submit it, of course.

3. How can we test this in dev without it redirecting to prod? Register an additional app with Beeminder? Put the client ID and whatever for that in a .env file? Or maybe Claude has an easier idea in AGENTS.md.

4. Infinite undo, why not.

5. Bug: the number in the field can get cut off in a way that doesn't let you see that it's being truncated. This may not matter for numbers you can realistically tap to but might do whatever polished UIs do in such a case.

6. Nix "Send" and "to" microcopy. More fathful emulation of the Beeminder dashboard UI for data entry. Main thing we *don't* want to from Beeminder's UI is the stepper buttons on the datapoint value, since that's redundant for TallyBee.

7. Need to see what date we're submitting for (see above).

8. Include the parenthetical sigma on the submit button for kyoom goals.

9. Probably include the previous datapoint, like the Beeminder dashboard does.

10. Link to the goal page on Beeminder.

11. The placeholder text for the datapoint comment should be the previous datapoint's comment, as on the Beeminder dashboard.

12. Anti-magic violation: preventing submission when the datapoint is zero. Death to if-statements.

13. I think pull-to-refresh should still work? Currently trying to do that just registers as another tally +1.

14. Bug: when picking a new goal from the dropdown, there's no spinner or graying out while you wait for the selection to take effect. It feels to the user like the app is just freezing/glitching briefly.

15. Bug: At least on my android device the bottom of the footer bar runs off the bottom of the screen and is inaccessible.

16. Bug: Uncaught exception if you put a non-number (or a number with a leading zero, which should probably be allowed) in the datapoint value field. Should give a nicer error, turn the field red, or just not let you put non-numeric characters in that field in the first place.

17. Maybe errors should be dismissable?

18. The goal dropdown seems way too wide. Goalnames are at most 20 characters. But I suppose if room we could also show the beginning of the goalblurb as well in the dropdown.

19. The big blue number should update in real time as you edit the datapoint value field. This ensures the user understands the datapoint value field and the big blue tally necessarily mirror each other. And you can always hit Undo if you didn't want to lose the tally. (Except currently Undo fails at that if you tap the tally after editing the datapoint value, since there's only 1 level of undo. Another reason to have infinite undo.)

20. Link explicitly to the github repo and sourcery.html at the bottom of the help popup. Anchor text can be "Source / Sourcery" with "Source" linking to the repo and "Sourcery" linking to sourcery.html.


## Open questions

1. Should TallyBee remember a separate count per goal?

2. Probably kill the "via TallyBee [timestamp]" as the default comment. It's an anti-magic violation and a deviation from the behavior of the Beeminder dashboard. On the other hand it's valuable for confirming datapoint submissions. Probably the right answer is that we should just make metadata like submission time easier to see.

3. Do we follow the Beeminder dashboard precendent of labeling the submit button "add progress"? I kind of like just "Submit".

4. Does there need to be a logout button? In principle yes, I guess? Maybe you want to let a friend do pushups with your phone. But it would be nice to minimize its footprint. Could we put seldom-used things like that in the help popup?

5. Maybe the static safesum text could be shown subtly at the very top of the screen. Maybe username/goalname there too. Save the footer control area for interactive elements. Also the current daily rate (plus upcoming daily rate, if different?) is something a user often wants visible.

6. What should happen when you load an odometer goal? Currently the app violates the seeming invariant that the big blue tally always mirrors the datapoint value field: the tally shows the delta and the field shows the absolute number.