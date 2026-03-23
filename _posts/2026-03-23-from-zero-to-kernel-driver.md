---
title: "From Zero to Kernel Driver — My Embedded Linux Journey"
date: 2026-03-23
categories: [Linux Kernel, Journey]
tags: [character driver, workqueue, spinlock, poll, v4l2, beaglebone]
---

I didn't start with a plan to write kernel drivers. I started with a question.

I was working at a hardware startup, reading through driver code I barely understood, and kept hitting the same wall — I could read the code, follow the syntax, but I had no mental model for *why* it was written that way. Why spinlock here and not mutex? Why does this function call `schedule_work` instead of doing the work directly? Why does the read function sleep, and how does it know when to wake up?

The only way I know how to answer questions like that is to build something from scratch, break it, fix it, and repeat until the answer stops feeling like memorisation and starts feeling like understanding.

This is that story.

---

## The Setup

A **Dell Latitude 5320** as my host and cross-compilation machine. A **BeagleBone Black** (AM335x, ARMv7) as the target — real hardware, not an emulator. I wanted the friction of deploying to actual silicon. Emulators are too forgiving.

The destination I had in mind from day one: **V4L2**. The Linux camera subsystem. Understand it deeply enough to write a real camera driver on embedded hardware. That's the north star everything else is aimed at.

---

## Driver 01 — Learning to Talk to the Kernel

The first driver was a character device backed by a circular buffer. Sixteen slots, 128 bytes each. You write a message to `/dev/sanath_queue`, you read it back.

Simple in concept. Not simple in execution.

The first thing I had to internalise was how userspace and kernel space are actually separated — not just conceptually but physically. You cannot pass a userspace pointer to `memcpy` and expect it to work. The kernel doesn't trust userspace pointers. They might not be mapped. They might be garbage. `copy_to_user` and `copy_from_user` exist because crossing that boundary requires validation and fault handling that raw memory copies don't provide.

The second thing was the `file_operations` struct — the table that tells the kernel which of my functions to call when userspace calls `open()`, `read()`, `write()`. This is the fundamental contract between a driver and the VFS. Get this wrong and nothing works. Get it right and the kernel handles all the plumbing.

The device node creation — `class_create`, `device_create` — was the moment it clicked that `/dev/` isn't magic. It's udev watching sysfs for events that the kernel emits when you call `device_create`. The node appears because I told the kernel to make it appear.

**The queue policy decision:** when the buffer is full, I overwrite the oldest entry. This wasn't laziness. It was a deliberate choice modelled on what V4L2 does — in a streaming system, fresh data matters more than old data. A camera doesn't wait for you to read the last frame before capturing the next one.

---

## Driver 02 — Three Ways to Read

The next driver asked a harder question: what if the buffer is empty when userspace calls `read()`?

There are three valid answers. Block until data arrives. Return immediately with an error. Or tell the caller to watch the file descriptor and call back when data is ready.

I implemented all three.

**Blocking read** uses a wait queue. The process calls `wait_event_interruptible_exclusive` and goes to sleep — literally removed from the scheduler's run queue — until another part of the driver calls `wake_up_interruptible`. No busy-waiting, no CPU consumed. The `_exclusive` part is important: if ten processes are all waiting for one message, you want exactly one of them to wake up, not all ten racing for the same slot.

**Non-blocking read** checks `filp->f_flags & O_NONBLOCK`. If the flag is set and the buffer is empty, return `-EAGAIN` immediately. The caller knows to try again later.

**poll/select** is the most interesting of the three. `poll_wait` doesn't sleep the process — it registers the process as interested in the wait queue, so when `wake_up` is called, the `poll` syscall gets notified and re-invokes the driver's poll function to check readiness. This is how `select()` on `/dev/videoX` works in every V4L2 application ever written.

---

## Driver 03 — Giving Userspace a Control Plane

Read and write are enough for data transfer. But drivers also need control — start this, stop that, tell me the current state.

That's what `ioctl` is for.

I added four commands: `GET_QUEUE_SIZE`, `GET_MAX_CAPACITY`, `CLEAR_QUEUE`, `RESET_DEVICE`. Each is defined using the `_IO`, `_IOR`, `_IOW` macros, which encode the direction of data transfer, a magic number to namespace the commands, a sequence number, and the size of the argument. This encoding is what lets the kernel detect mismatches between userspace and kernel definitions at runtime.

The thing that surprised me: `unlocked_ioctl`. The old `.ioctl` field held the Big Kernel Lock while executing — one ioctl at a time across the entire kernel. `.unlocked_ioctl` lets drivers manage their own locking, which is what every modern driver does. The BKL was removed entirely in 2.6.39.

---

## Driver 04 — The Kernel Starts Producing Data

The first three drivers were passive — they waited for userspace to write something before there was anything to read. Driver 04 inverted that.

A kernel timer fires every second and writes an event into the ring buffer. Userspace just reads. The kernel is now the producer.

This is where everything got harder.

Timer callbacks run in **softirq context**. Atomic context. No sleeping, no mutexes, no `kmalloc(GFP_KERNEL)`, keep it short. The mutex I'd been using in the previous drivers became illegal. I switched to `spin_lock_irqsave`.

The `irqsave` part matters: it saves the CPU's interrupt enable state before disabling local interrupts, and restores it exactly on unlock. The reason you save rather than blindly re-enable is that the caller might have already disabled interrupts before acquiring the lock. Blindly re-enabling would violate that assumption.

Then I hit the `copy_to_user` bug.

I had `copy_to_user` inside the spinlock. It compiled. It ran. Then it returned `-EFAULT` intermittently. The reason: `copy_to_user` can page fault if the user page isn't mapped yet. Handling a page fault requires sleeping. Sleeping inside a spinlock is illegal. The fix was to `memcpy` into a local kernel buffer inside the lock, release the lock, then call `copy_to_user` on the local copy.

Then I hit the timer re-arm bug.

`del_timer_sync` cancels a pending timer and waits for any running callback to finish. But "waits for the callback to finish" doesn't mean "prevents the callback from re-arming the timer." If the callback had already started, checked its condition, and decided to re-arm — all before `del_timer_sync` was called — the timer would fire again after the sync returned. The fix was a `timer_active` flag, checked inside the callback before re-arming. STOP clears the flag first, then calls `del_timer_sync`. The callback sees the cleared flag and does not re-arm.

Seven bugs total in this driver. Every one of them taught me something.

---

## Driver 05 — Getting Out of Atomic Context

The timer callback in driver 04 was doing too much work in softirq context. The pattern doesn't scale — as soon as you need to do anything non-trivial in response to a timer, atomic context becomes a hard constraint.

The solution is a workqueue.

`schedule_work` queues a work item that executes in a kernel thread running in process context. Process context can sleep. Process context can allocate memory. Process context can take mutexes. It's the right place for anything that isn't strictly latency-critical.

The timer callback now does one thing: `schedule_work`. The actual buffer write happens in the workqueue function.

This is the pattern V4L2 drivers use for frame processing. The hardware interrupt signals that a frame is ready; the interrupt handler or timer schedules work; the workqueue processes the frame in a context where it can actually do something useful.

Module exit required a specific teardown order: `del_timer_sync` first to stop the timer, then `flush_work` to wait for any already-queued work item to finish, then destroy device resources. Get the order wrong and you free memory that's still being accessed.

---

## Driver 06 — The Complete Picture

The final driver combined everything: workqueue-based async producer, ring buffer with drop-oldest policy, blocking read, non-blocking read, and poll/select support.

This is the full I/O model that a V4L2 application uses:

- Open `/dev/videoX`
- Call `poll()` waiting for a frame
- When poll returns readable, call `read()` or `DQBUF` to consume it
- Optionally use `O_NONBLOCK` to check readiness without blocking

Driver 06 implements exactly that pattern, minus the V4L2-specific ioctl layer.

`wait_event_interruptible_exclusive` on the read path. `poll_wait` with `POLLIN | POLLRDNORM` on the poll path. `O_NONBLOCK` / `EAGAIN` on the non-blocking path. `file->private_data` for per-fd state so multiple processes can each have their own open instance without sharing state.

---

## Where This Goes Next

Six drivers. One BeagleBone Black. Several kernel panics that taught me more than any documentation could.

The next steps are hardware: a GPIO driver that talks to real pins on the AM335x, an interrupt-driven driver that responds to actual hardware signals, and a platform driver that binds through the device tree. Those three unlock V4L2, which is where this whole journey has been pointed from the start.

Everything built here — the ring buffer, the wait queues, the poll interface, the workqueue pattern — is the same machinery V4L2 uses. The `videobuf2` subsystem is a more sophisticated ring buffer with DMA-coherent allocation. `VIDIOC_DQBUF` is a fancier version of the read path. `select()` on a video device is exactly the poll mechanism implemented in driver 02.

The fundamentals are in place. The hardware is next.

---

*All code is on GitHub: [linux-driver-lab](https://github.com/sanathsapre/linux-driver-lab)*
