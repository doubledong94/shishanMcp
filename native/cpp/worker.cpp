// Demo C++ worker — a compiled binary launched as a subprocess by the MCP
// backend. Takes the upper bound as argv[1], prints a JSON line to STDOUT.
//
// Compile (see scripts/build-cpp.sh):  g++ -O2 -std=c++17 -o worker worker.cpp
// In Docker this is compiled in the native-build stage and copied to /opt/bin/worker.
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

int main(int argc, char **argv) {
  if (argc < 2) {
    std::cerr << "usage: worker <n>\n";
    return 2;
  }

  uint64_t n;
  try {
    n = std::stoull(argv[1]);
  } catch (...) {
    std::cerr << "worker error: bad n\n";
    return 2;
  }

  // Sieve of Eratosthenes — sum of all primes <= n.
  std::vector<bool> is_prime(n + 1, true);
  if (n >= 0) is_prime[0] = false;
  if (n >= 1) is_prime[1] = false;

  uint64_t sum = 0;
  for (uint64_t i = 2; i <= n; ++i) {
    if (!is_prime[i]) continue;
    sum += i;
    if (i <= n / i) {  // avoid i*i overflow
      for (uint64_t j = i * i; j <= n; j += i) is_prime[j] = false;
    }
  }

  std::cout << "{\"n\":" << n << ",\"sum_of_primes\":" << sum
            << ",\"language\":\"c++\"}\n";
  return 0;
}
