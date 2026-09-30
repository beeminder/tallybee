https://tallybee.beeminder.com

## Wishlist

1. DONE: Handle a 401 error, which happens if you log in to TallyBee on multiple devices.

2. Make the UI in the bottom strip non-hideous.

3. Reset to zero when you hit submit, but only if submission actually succeeds. Relatedly, it needs to be super clear when/if the submission succeeds. Show a flying infinibee until the Beeminder server responds?

4. The "bottom modal" when you click the "background" button doesn't work on mobile -- there's no way to dismiss it if the screen is too small for the X (close button) to be visible. Also it should just be a normal help button with a question mark icon or whatever. Not "background" what the heck was I thinking?

5. Show amount of safety buffer or the delta to dispatch the beemergency (for the selected Beeminder goal).

6. All the standard favicon/link-preview stuff. And making it installable as a PWA or however that works on mobile.

7. What we really need is a way to have an icon on your phone's homescreen that opens up TallyBee with a specific Beeminder goal selected.

8. Desideratum: it should never forget the current number you've tallied up to.

9. How can we test this in dev without it redirecting to prod?

10. Show safesum, like "+37 pushups due by 5pm"

11. Is it my imagination or do the big blue numbers flicker more than necessary when they increment?

12. The empty dropdown menu when you haven't logged in yet looks weird. Also the "Send XX to" doesn't look very grayed out in the non-logged-in case.

13. Maybe the help button should go in the bottom corner? Things like this need a designer's eye. Do research, find precedents and best practices.

## Open questions

1. Should TallyBee remember a separate count per goal?

2. Is there a use case for switching to decrement mode, or does the Undo button cover that?