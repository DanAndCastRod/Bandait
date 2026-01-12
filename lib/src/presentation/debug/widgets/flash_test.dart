import 'package:flutter/material.dart';

class FlashTest extends StatelessWidget {
  final bool isFlashing;

  const FlashTest({super.key, required this.isFlashing});

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 50),
      height: 100,
      width: double.infinity,
      decoration: BoxDecoration(
        color: isFlashing ? Colors.white : Colors.black,
        border: Border.all(color: Colors.white24),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Center(
        child: Text(
          isFlashing ? 'FLASH!' : 'Flash Visual',
          style: TextStyle(
            color: isFlashing ? Colors.black : Colors.white,
            fontWeight: FontWeight.bold,
            fontSize: 20,
          ),
        ),
      ),
    );
  }
}
