//go:build ignore

// lipo: produces a Mach-O fat (universal) binary from two single-arch
// Mach-O binaries. A minimal replacement for Apple's `lipo -create` that
// runs anywhere Go runs. Outputs FAT_MAGIC_64 format so files >4GB work.
//
// Usage: go run build/lipo.go -out OUT IN_AMD64 IN_ARM64
package main

import (
	"encoding/binary"
	"flag"
	"fmt"
	"io"
	"os"
)

const (
	fatMagic64 = 0xCAFEBABF // 64-bit fat header, big-endian on disk

	cpuTypeX86_64 = 0x01000007
	cpuTypeARM64  = 0x0100000C

	cpuSubtypeX86_64All = 3
	cpuSubtypeARM64All  = 0
)

type fatArch64 struct {
	CPUType    uint32
	CPUSubtype uint32
	Offset     uint64
	Size       uint64
	Align      uint32 // log2 alignment, e.g. 14 = 16 KiB
	Reserved   uint32
}

func main() {
	out := flag.String("out", "", "output path")
	flag.Parse()
	if *out == "" || flag.NArg() != 2 {
		fmt.Fprintln(os.Stderr, "usage: lipo -out OUT AMD64 ARM64")
		os.Exit(2)
	}
	if err := run(*out, flag.Arg(0), flag.Arg(1)); err != nil {
		fmt.Fprintln(os.Stderr, "lipo:", err)
		os.Exit(1)
	}
}

func run(outPath, amd64Path, arm64Path string) error {
	amd64Data, err := os.ReadFile(amd64Path)
	if err != nil {
		return err
	}
	arm64Data, err := os.ReadFile(arm64Path)
	if err != nil {
		return err
	}

	const align = 14 // 2^14 = 16 KiB, the macOS page size on arm64
	headerSize := 8 + 2*48 // fat_header + 2 * fat_arch_64

	off1 := alignUp(uint64(headerSize), 1<<align)
	off2 := alignUp(off1+uint64(len(amd64Data)), 1<<align)

	f, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer f.Close()

	if err := binary.Write(f, binary.BigEndian, uint32(fatMagic64)); err != nil {
		return err
	}
	if err := binary.Write(f, binary.BigEndian, uint32(2)); err != nil {
		return err
	}

	arches := []fatArch64{
		{CPUType: cpuTypeX86_64, CPUSubtype: cpuSubtypeX86_64All, Offset: off1, Size: uint64(len(amd64Data)), Align: align},
		{CPUType: cpuTypeARM64, CPUSubtype: cpuSubtypeARM64All, Offset: off2, Size: uint64(len(arm64Data)), Align: align},
	}
	for _, a := range arches {
		if err := binary.Write(f, binary.BigEndian, a); err != nil {
			return err
		}
	}

	if err := padTo(f, off1); err != nil {
		return err
	}
	if _, err := f.Write(amd64Data); err != nil {
		return err
	}
	if err := padTo(f, off2); err != nil {
		return err
	}
	if _, err := f.Write(arm64Data); err != nil {
		return err
	}
	return nil
}

func alignUp(v, a uint64) uint64 {
	return (v + a - 1) &^ (a - 1)
}

func padTo(f *os.File, target uint64) error {
	cur, err := f.Seek(0, io.SeekCurrent)
	if err != nil {
		return err
	}
	if uint64(cur) > target {
		return fmt.Errorf("padTo: already past target (%d > %d)", cur, target)
	}
	if uint64(cur) == target {
		return nil
	}
	zeros := make([]byte, target-uint64(cur))
	_, err = f.Write(zeros)
	return err
}
