use std::num::NonZeroUsize;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;

type Job = Box<dyn FnOnce() + Send>;

/// The metric passes recurse per tree level (TreeIndex refuses trees deeper than 5,000), so workers
/// get the stack size of a typical main thread instead of Rust's 2 MiB default.
const STACK_SIZE: usize = 8 * 1024 * 1024;

/// Runs the job on a process-wide pool with one thread per available core. A dedicated pool rather
/// than libuv's (4 threads by default) lets measurements use every core without the embedding
/// process having to raise UV_THREADPOOL_SIZE before its first I/O. The pool keeps however many
/// workers the OS allows (a thread or PID limit may refuse some); with none, the job runs on the
/// calling thread instead.
pub fn spawn(job: impl FnOnce() + Send + 'static) {
    static SENDER: OnceLock<Option<mpsc::Sender<Job>>> = OnceLock::new();
    let sender = SENDER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel::<Job>();
        let receiver = Arc::new(Mutex::new(receiver));
        let mut started = 0;
        for _ in 0..thread::available_parallelism().map_or(1, NonZeroUsize::get) {
            let receiver = Arc::clone(&receiver);
            let spawned = thread::Builder::new()
                .name("code-gauge-worker".to_string())
                .stack_size(STACK_SIZE)
                .spawn(move || loop {
                    let job = receiver
                        .lock()
                        .expect("jobs run after the lock is released, so it is never poisoned")
                        .recv();
                    match job {
                        Ok(job) => job(),
                        Err(_) => return,
                    }
                });
            if spawned.is_err() {
                break;
            }
            started += 1;
        }
        (started > 0).then_some(sender)
    });
    let job: Job = Box::new(job);
    match sender {
        Some(sender) => {
            if let Err(mpsc::SendError(job)) = sender.send(job) {
                job();
            }
        }
        None => job(),
    }
}
