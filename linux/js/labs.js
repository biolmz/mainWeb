/* 操作系统课程实验库 - 每个实验: 生成源码 + 编译 + 运行 */
const LABS = [
  {
    id: "hello",
    name: "Hello World",
    desc: "最简 C 程序，验证编译链路",
    file: "hello.c",
    code: `#include <stdio.h>
int main(void) {
    printf("Hello, TinyCore in Browser!\\n");
    printf("This is x86 (32-bit) Linux via v86 WASM emulation.\\n");
    return 0;
}`,
    run: "./hello"
  },
  {
    id: "fork",
    name: "fork 进程实验",
    desc: "进程创建 fork/wait/pid",
    file: "fork.c",
    code: `#include <stdio.h>
#include <unistd.h>
#include <sys/wait.h>
int main(void) {
    pid_t pid = fork();
    if (pid == 0) {
        printf("[child]  pid=%d, parent=%d\\n", getpid(), getppid());
        _exit(0);
    } else if (pid > 0) {
        int status;
        printf("[parent] pid=%d, waiting child %d...\\n", getpid(), pid);
        wait(&status);
        printf("[parent] child exited, status=%d\\n", WEXITSTATUS(status));
    } else {
        perror("fork");
        return 1;
    }
    return 0;
}`,
    run: "./fork"
  },
  {
    id: "syscall",
    name: "直接系统调用",
    desc: "绕过 libc，syscall 直呼内核",
    file: "syscall.c",
    code: `#include <unistd.h>
#include <sys/syscall.h>
#include <string.h>
int main(void) {
    const char *msg = "syscall(1, write) 直接调用内核!\\n";
    syscall(SYS_write, 1, msg, strlen(msg));
    return 0;
}`,
    run: "./syscall"
  },
  {
    id: "malloc",
    name: "内存分配实验",
    desc: "malloc + /proc statm 观察",
    file: "malloc.c",
    code: `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(void) {
    int *arr = malloc(1024 * 1024);
    if (!arr) { perror("malloc"); return 1; }
    memset(arr, 0x5a, 1024 * 1024);
    printf("malloc 1MB ok @ %p\\n", (void*)arr);
    printf("PID=%d, 查看 /proc/%d/statm 观察内存\\n", getpid(), getpid());
    system("cat /proc/self/statm");
    free(arr);
    return 0;
}`,
    run: "./malloc"
  },
  {
    id: "threads",
    name: "pthread 线程",
    desc: "多线程并发执行",
    file: "threads.c",
    code: `#include <stdio.h>
#include <pthread.h>
#include <unistd.h>
void *worker(void *arg) {
    int id = *(int*)arg;
    for (int i = 0; i < 3; i++) {
        printf("thread %d: iteration %d\\n", id, i);
        usleep(100000);
    }
    return NULL;
}
int main(void) {
    pthread_t t1, t2;
    int a = 1, b = 2;
    pthread_create(&t1, NULL, worker, &a);
    pthread_create(&t2, NULL, worker, &b);
    pthread_join(t1, NULL);
    pthread_join(t2, NULL);
    printf("all threads done\\n");
    return 0;
}`,
    run: "./threads"
  },
  {
    id: "signal",
    name: "信号处理",
    desc: "signal/SIGINT 捕获",
    file: "signal.c",
    code: `#include <stdio.h>
#include <signal.h>
#include <unistd.h>
void handler(int sig) {
    printf("\\n[caught] signal %d (SIGINT)\\n", sig);
    _exit(0);
}
int main(void) {
    signal(SIGINT, handler);
    printf("按 Ctrl+C 触发 SIGINT (在浏览器里发 ^C)\\n");
    for (;;) pause();
    return 0;
}`,
    run: "./signal"
  },
  {
    id: "files",
    name: "文件系统操作",
    desc: "open/write/stat/inode",
    file: "files.c",
    code: `#include <stdio.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
int main(void) {
    int fd = open("/tmp/data.txt", O_CREAT|O_WRONLY|O_TRUNC, 0644);
    if (fd < 0) { perror("open"); return 1; }
    write(fd, "file-system experiment\\n", 23);
    close(fd);
    struct stat st;
    stat("/tmp/data.txt", &st);
    printf("size=%ld, inode=%ld, links=%ld\\n",
           (long)st.st_size, (long)st.st_ino, (long)st.st_nlink);
    return 0;
}`,
    run: "./files"
  },
  {
    id: "ps",
    name: "内核信息",
    desc: "uname/ps/mount 内核视图",
    file: null,
    code: null,
    run: null,
    extra: "uname -a && echo '----' && ps && echo '----' && mount | head -8 && echo '----' && cat /proc/version"
  }
];
