# Features

Add/Edit worker
- add worker to company
    + qualifications
    + age/weakness rating 0-10


Add/Edit/Delete work
- add work to pool
    + qualifications
    + phsycial demand 0-10
    + auto assigned or manual
    + progress 0-100%
    + is reassigned each work assignment meeting
- option to duplicate work

Work Assignment Meeting
- at work assignment meeting, load up all unassigned work
- option to determine how many tasks each worker can review
- worker scan qr code to go to page and rate how much they desire each work item
    + workers are most likely to rate work that best fits their qualifications
- after all workers are done, run the auto assign work below
- button to see stats, including list of jobs from most desired to least desired, and who got each one

Auto assign work
- collect pool of qualified workers
- split into older or otherwise weaker workers, and able bodied workers
- run first for older and weaker, then for the other workers
    + if for older or weaker, make sublist of less physically demanding jobs
    + determine worker probability for each job, and assign with random chance on probabilities
        * get how much 0-10 each worker desires job, or average rating from other workers, or 5 as a default
        * subtract worker's current score (updated with each job by averageing current score with how much the worker desired the job, starts out at 5)
        * get score for each worker and convert into probabilities that sum to 100, then random choice to determine who's assigned


Manual assign/manage work
- manage work assignments
- view unassigned work

# Tech stack

Just vanilla js frontend, and vanilla python backend. No dependencies or frameworks if possible

# Style
Something fun, but also simple and easy to use. We'd prefer pages without too much clutter

