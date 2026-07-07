SRCS=main.c interpolation.c read.c write.c load_meteo.c eulerian.c lagrangian.c trajectory.c
LIBS=-lm -lnetcdf

UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
# macOS: Apple clang needs libomp; netcdf/libomp from Homebrew
BREW_PREFIX := $(shell brew --prefix 2>/dev/null || echo /opt/homebrew)
CC=clang
OMPFLAGS=-Xpreprocessor -fopenmp
CFLAGS=-O3 -I$(BREW_PREFIX)/opt/libomp/include -I$(BREW_PREFIX)/opt/netcdf/include
LDFLAGS=-L$(BREW_PREFIX)/opt/libomp/lib -L$(BREW_PREFIX)/opt/netcdf/lib
LIBS+=-lomp
else
CC=gcc
OMPFLAGS=-fopenmp
CFLAGS=-O3
LDFLAGS=
endif

all:
	$(CC) $(OMPFLAGS) $(CFLAGS) -o run_recycling $(SRCS) $(LDFLAGS) $(LIBS)

clean:
	rm -f run_recycling *.o
