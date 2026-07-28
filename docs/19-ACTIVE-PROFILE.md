# 19 · One profile at a time

> Status: design of record, 2026-07-28. Activities:
> [18-ACTIVITIES.md](./18-ACTIVITIES.md) · Spaces & profile:
> [17-SPACES-AND-PROFILE.md](./17-SPACES-AND-PROFILE.md) · Continuity:
> [16-CONTINUITY.md](./16-CONTINUITY.md).

## 1. Five pickers for one fact

"Whose dashboard is this?" was asked separately by every profile-scoped
surface: the Library's Spaces, Documents, and Memory tabs, the start modal, and
the Interview, Mock, and Sparring pages. Each carried the same three lines —

```ts
const [profileId, setProfileId] = useState('');
useEffect(() => { if (!profileId && profiles.length) setProfileId(profiles[0].id) }, …);
<Select value={profileId} …>
```

— and each defaulted independently. Nothing tied them together, so they could
disagree: you could be reading one person's Spaces while the start modal was
primed to run a session as someone else. The user never gets told which answer
won.

**The profile is now chosen once, in the sidebar, above the nav** — so the
scope of everything below it is visible while you use it, rather than re-asked
per page. `ProfileSwitcher` is the only picker; "+ New profile…" sits in the
same menu, because both answer the same question and splitting them would put
the rarer action in the bigger target.

## 2. Where it lives, and why in main

`AppSettings.activeProfileId` (settings key `active_profile_id`) — persisted,
so it survives a restart, and resolved in **main** so every window agrees,
including the Cue Card, which has no picker of its own.

A stored id is a pointer, and pointers dangle: profiles get deleted, databases
get restored, the setting outlives the row it names. `resolveActiveProfile`
(`shared/activeProfile.ts`) therefore validates against the real rows on every
read and falls back to a profile that exists.

**A dangling id must never blank the app.** Every list is scoped by this one
value, so a stale pointer would empty all of them at once — and "empty" is
indistinguishable from "broken". `null` is returned only when there are
genuinely no profiles, which is exactly the signal the first-run gate needs.

## 3. First run is a question, not an empty app

With no profile, every surface rendered as an empty list behind a picker with
nothing in it. That reads as a broken install rather than as "start here".

`NewProfileModal` with `dismissable={false}` now covers the app until a profile
exists — no Escape, no Cancel, because there is nothing behind it to go back to.

**It asks for a name and nothing else.** Everything else about a person — what
they do, who they work with, how they want to be helped — lives in the profile
editor ([17 §2](./17-SPACES-AND-PROFILE.md)) and is optional there. Demanding it
before the app has done anything for them is how the old onboarding turned into
a job application.

The same component is the switcher's "New profile…", dismissable.

## 4. Home says the name

`Hi {first name} — how can I help right now?`

Not decoration: it is the visible proof of which profile the whole page is
scoped to. A dashboard scoped by an invisible setting is a dashboard you cannot
trust.

## 5. Two kinds of nav

Once the profile scopes the app, the sidebar's entries stop being one list:

| Group | Entries | What it is |
| --- | --- | --- |
| *(labelled with the active profile's name)* | Home, Library, Sessions, Insights | views of ONE person; every one changes when the switcher changes |
| **App** | Profiles, Settings | about the app, or about the set of people; does not move when you switch |

Running them together made the switcher look like it scoped Settings too, and
hid that the four above it are all views of whoever is selected. The first
group's label is the profile's own **name** — the plainest available statement
of what changes when you switch.

## 6. The Library stops being two things

`Library › Profile` listed every profile, created them, and deleted them —
sitting beside three tabs that each showed exactly *one* profile's things. So
the Library answered both "what does BrainCue know about you?" and "which
you?". Those are different questions and they now have different homes:

- **which you** → the sidebar switcher;
- **the set of people** → `/profiles`, a global page in the App group;
- **who you are** → the profile editor at `/profiles/:id`;
- **what it knows about the active one** → the Library (Spaces, Documents,
  Memory), default tab Spaces.

### Sample data has to survive the gate

"Load sample data" lived only on that tab. With the first-run modal covering
the whole app until a profile exists, the one page offering it sat behind the
very gate you could not pass — so a fresh install could no longer try the app
with sample data at all. The modal offers it directly.

## 7. What did NOT change

- **Profiles remain the unit of ownership.** Spaces, sessions, chunks, and
  memories were always keyed by `profile_id`; this changes who is selected, not
  what belongs to whom.
- **Settings stays global.** It always was; it just no longer sits in a list
  that implies otherwise.
- **No migration.** A setting, not a column.
