use std::num::NonZeroUsize;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;

type Job = Box<dyn FnOnce() + Send>;

/// The metric passes recurse per tree level (TreeIndex refuses trees deeper than 5,000), so workers
/// get the stack size of a typical main thread instead of Rust's 2 MiB default.
const STACK_SIZE: usize = 8 * 1024 * 1024;

/// Runs the job on a process-wide pool with one thread per available core. A dedicated pool rather
/// than libuv's (4 threads by default) lets measurements use every core without the embedding
/// process having to raise UV_THREADPOOL_SIZE before its first I/O.
pub fn spawn(job: impl FnOnce() + Send + 'static) {
    static SENDER: OnceLock<mpsc::Sender<Job>> = OnceLock::new();
    SENDER
        .get_or_init(|| {
            let (sender, receiver) = mpsc::channel::<Job>();
            let receiver = Arc::new(Mutex::new(receiver));
            for _ in 0..thread::available_parallelism().map_or(1, NonZeroUsize::get) {
                let receiver = Arc::clone(&receiver);
                thread::Builder::new()
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
                    })
                    .expect("failed to spawn a code-gauge worker thread");
            }
            sender
        })
        .send(Box::new(job))
        .expect("workers live as long as the sender");
}
